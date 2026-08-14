const vscode = require('vscode');
const {
  CorpClient, CorpAuthError, describeConflict, describeRequest,
  CHARS_PER_TOKEN, DEFAULT_CONTEXT_CHARS,
} = require('./corpClient');
const { withContinuation } = require('./continuation');
const {
  buildToolPrompt, budgetFor, ToolCallScanner, hasUnfinishedCall, restartsToolCall,
  dropOpenToolCall,
} = require('./toolshim');
const { getToken, getCookie, getPrivate, readSetting } = require('./storage');

/**
 * One piece of a tool result as text.
 *
 * A result part is not always text: a tool that builds its result with prompt-tsx
 * hands back a `LanguageModelPromptTsxPart` whose `value` is an object. String
 * concatenation turns that into "[object Object]", so the model is told the tool
 * ran and told nothing about what it found - and it reissues the same call.
 */
function resultPieceToText(piece) {
  if (typeof piece === 'string') return piece;
  const value = piece?.value;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Read a VS Code message part without depending on class identity across API versions. */
function partToPieces(part) {
  if (typeof part === 'string') return { text: part };
  if (part == null) return {};
  // A LanguageModelDataPart carries bytes and a mime type, and no `value` - so it
  // matched none of the branches below and fell through to {} - which is exactly
  // how an attached screenshot used to vanish between the chat box and the prompt.
  // Not every data part is an image: the same class carries text attachments, and
  // VS Code also uses it for internal markers that have no place in a prompt.
  if (part.mimeType && part.data) {
    const mimeType = String(part.mimeType);
    if (mimeType.startsWith('image/')) {
      return { image: { mimeType, data: Buffer.from(part.data).toString('base64') } };
    }
    if (/^text\/|^application\/(json|xml|yaml)/.test(mimeType)) {
      return { text: Buffer.from(part.data).toString('utf8') };
    }
    return {};
  }
  if (typeof part.value === 'string') return { text: part.value };
  if (part.name && 'input' in part) {
    return { toolCall: { callId: part.callId, name: part.name, input: part.input } };
  }
  if ('callId' in part && 'content' in part) {
    const content = Array.isArray(part.content)
      ? part.content.map(resultPieceToText).join('')
      : resultPieceToText(part.content) || String(part.content ?? '');
    return { toolResult: { callId: part.callId, content } };
  }
  return {};
}

class EllmChatProvider {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    // Mismatches repeat on every request of a session; warn on each distinct
    // pair once so a wrong model is visible without becoming noise.
    this.warnedModels = new Set();
    this.warnedConflicts = new Set();
  }

  refresh() {
    this._onDidChange.fire();
  }

  log(msg) {
    this.output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  async client() {
    return new CorpClient({
      url: readSetting(this.context, 'url'),
      token: await getToken(this.context),
      cookie: await getCookie(this.context),
      authHeader: readSetting(this.context, 'authHeader'),
      authPrefix: readSetting(this.context, 'authPrefix'),
      chatPath: readSetting(this.context, 'chatPath'),
      promptField: readSetting(this.context, 'promptField'),
      modelField: readSetting(this.context, 'modelField'),
      models: String(readSetting(this.context, 'models'))
        .split(',').map((s) => s.trim()).filter(Boolean),
      textPath: readSetting(this.context, 'textPath'),
      servedModelPath: readSetting(this.context, 'servedModelPath'),
      maxResponseChars: readSetting(this.context, 'maxResponseChars'),
      // Was accepted by the constructor and never passed, so the 400000 default
      // was an unchangeable constant wearing the clothes of a setting. A knob that
      // is only half wired is worse than an honest literal: the code reads as
      // though the case is covered.
      contextChars: readSetting(this.context, 'contextChars'),
      imageField: readSetting(this.context, 'imageField'),
      // Empty keeps the flattened prompt every earlier version sent. Naming a key
      // sends the conversation as a real message array instead - opt-in, because a
      // backend handed a field it does not know does not complain, it just answers
      // from whatever it did understand.
      messagesField: readSetting(this.context, 'messagesField'),
      messagesFormat: readSetting(this.context, 'messagesFormat'),
      // Identity and tuning are private to this machine - see storage.js.
      identity: getPrivate(this.context, 'identity', {}),
      params: getPrivate(this.context, 'params', {}),
    });
  }

  // --- 1. which models this provider offers ---------------------------------
  async provideLanguageModelChatInformation(options, _token) {
    const client = await this.client();
    if (!client.configured) {
      this.log('not configured yet - run "Enterprise LLM: Configure Connection"');
      return [];
    }

    try {
      const info = await client.listModels();
      const cap = info.limits?.maxResponseChars ?? 5000;
      // Claiming vision the backend does not have is worse than admitting none:
      // VS Code would hand over the attachment, the prompt would carry no picture,
      // and the model would describe one it never saw. So the claim is tied to
      // there being a body field to actually put the image in.
      const takesImages = Boolean(client.imageField);
      this.log(`discovered ${info.models.length} model(s), upstream cap ${cap} chars`
        + `, images ${takesImages ? `sent as "${client.imageField}"` : 'not supported'}`);

      return info.models.map((m) => ({
        id: m.alias,
        name: `${m.label} (Enterprise)`,
        // One family per model, not one for the whole provider. `corp-ellm` is the
        // vendor id; using it here made every model identical to anything that
        // selects by family - selectChatModels({family}) would match all of them
        // and take the first, and surfaces that label by family showed the vendor
        // id where the model name belongs.
        family: m.alias,
        version: '1.0.0',
        maxInputTokens: Math.floor((m.contextChars ?? DEFAULT_CONTEXT_CHARS) / CHARS_PER_TOKEN),
        // Deliberately far above the upstream's per-response cap: the continuation
        // layer stitches capped rounds into one answer.
        maxOutputTokens: 32000,
        tooltip: `Enterprise LLM via ${client.url}`,
        detail: `${cap}-char cap, auto-continued`,
        capabilities: { toolCalling: true, imageInput: takesImages },
      }));
    } catch (err) {
      this.log(`model discovery failed: ${err.message}`);
      if (!options.silent) vscode.window.showErrorMessage(`Enterprise LLM: ${err.message}`);
      return [];
    }
  }

  // --- 2. answering a request ------------------------------------------------
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const client = await this.client();
    if (!client.configured) throw new Error('Enterprise LLM is not configured.');

    const tools = (options?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    const shimming = tools.length > 0;

    // Read once and used twice: the budget the model is told about and the cap the
    // continuation layer recovers from must come from the same number, or the model is
    // aiming at a limit that is not the one being enforced.
    const cap = readSetting(this.context, 'maxResponseChars');
    const budget = budgetFor(cap);

    const turns = this.toTurns(messages, shimming);
    if (shimming) {
      turns.unshift({
        speaker: 'system',
        utterance: buildToolPrompt(tools, { budgetChars: budget }),
      });
      this.log(`${tools.length} tool(s) offered, reply budget ${budget} chars (cap ${cap})`);
    }

    // Speakers and sizes of what is about to be sent - never content.
    //
    // This existed in v0.4.4, was lost in the v0.5.0 revert, and its absence is why
    // the next problem took guesswork instead of a glance. When a backend truncates
    // from the front, the failure looks like a model ignoring the request; the only
    // way to see it is the total, and which turn is carrying the weight. The
    // configured budget is printed beside it so "too big" is a comparison, not a
    // hunch.
    const total = turns.reduce((n, t) => n + (t.utterance?.length ?? 0), 0);
    const budgetChars = readSetting(this.context, 'contextChars');
    this.log(`turns: ${turns.map((t) => `${t.speaker}(${t.utterance?.length ?? 0})`).join(' ')}`
      + ` = ${total} chars of ${budgetChars} budget`
      + (total > budgetChars
        ? ' -- OVER BUDGET: the backend will truncate, and it truncates from the FRONT'
        : ''));

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());

    // The names are what let the scanner recognise a call the model wrote without
    // the tags. `{"name": ...}` alone is ambiguous - a call in an agent turn, an
    // example in an answer about JSON - and matching against the tools actually on
    // offer is the only thing that tells the two apart.
    const scanner = shimming
      ? new ToolCallScanner(
        (msg) => this.log(`TOOL CALL PROBLEM: ${msg}`),
        tools.map((t) => t.name),
      )
      : null;
    const started = Date.now();
    let chars = 0;
    let calls = 0;

    try {
      const rounds = (roundTurns, signal) => client.converse({
        modelAlias: model.id,
        turns: roundTurns,
        signal,
        // One verbatim frame per request: if the backend changes shape, this line
        // is the difference between a five-minute fix and an afternoon.
        onRawFrame: (raw) => this.log(`first raw frame: ${raw}`),
        onServedModel: (served) => this.reportServedModel(served),
        // What the request says about the model, logged before it is sent. When
        // the picker appears to do nothing, this line and the DevTools capture
        // side by side are the whole diagnosis.
        onRequest: (shape) => this.reportRequestShape(shape),
        // A frame the reader could not read is never shown in the chat, so the
        // log is the only place it exists. Without this line a recovered or
        // dropped frame would be invisible.
        onFrameProblem: (msg) => this.log(`frame problem: ${msg}`),
      });

      const stream = withContinuation(rounds, turns, {
        maxResponseChars: cap,
        maxContinuations: readSetting(this.context, 'maxContinuations'),
        // A file written through a 5000-char cap arrives over many rounds, and a
        // backend that reports a clean stop for a capped response would otherwise
        // end the answer mid-JSON. An unclosed tool call settles it - including one
        // the model wrote without the tags, which is most of them by the time a
        // reply is long enough to be cut in half.
        needsMore: shimming
          ? (text) => hasUnfinishedCall(text, tools.map((t) => t.name))
          : undefined,
        // ...and if the model answers "continue" by writing the call again from
        // the top, keep the new one. Splicing it onto the abandoned half is how a
        // file gets written with its middle duplicated.
        restarted: shimming ? restartsToolCall : undefined,
        dropStale: shimming ? dropOpenToolCall : undefined,
        signal: controller.signal,
        log: (m) => this.log(m),
      });

      const emit = ({ text, calls: found }) => {
        if (text) {
          chars += text.length;
          progress.report(new vscode.LanguageModelTextPart(text));
        }
        for (const c of found) {
          // A throw here escapes provideLanguageModelChatResponse and fails the
          // whole reply - so one badly shaped argument object would discard the
          // prose already streamed and end the agent loop, rather than costing
          // the single call it belongs to.
          let input;
          try {
            input = JSON.parse(c.function.arguments || '{}');
          } catch (err) {
            this.log(`TOOL CALL PROBLEM: arguments for "${c.function.name}" are not `
              + `JSON (${err.message}); calling it with no arguments`);
            input = {};
          }
          if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            this.log(`TOOL CALL PROBLEM: arguments for "${c.function.name}" came back as `
              + `${Array.isArray(input) ? 'an array' : typeof input}, not an object`);
            input = {};
          }
          calls++;
          progress.report(new vscode.LanguageModelToolCallPart(c.id, c.function.name, input));
        }
      };

      for await (const ev of stream) {
        if (token.isCancellationRequested) break;
        if (ev.type === 'restart') {
          scanner?.dropOpenCall();
          continue;
        }
        if (ev.type !== 'text' || !ev.text) continue;

        if (scanner) {
          emit(scanner.push(ev.text));
        } else {
          chars += ev.text.length;
          progress.report(new vscode.LanguageModelTextPart(ev.text));
        }
      }

      // Whatever the scanner is still holding - an untagged or badly closed call.
      if (scanner) emit(scanner.flush());

      this.log(`response complete: ${chars} chars, ${calls} tool call(s), ${Date.now() - started}ms`);
    } catch (err) {
      if (err instanceof CorpAuthError) {
        vscode.window.showErrorMessage(`Enterprise LLM: ${err.message}`, 'Configure')
          .then((pick) => pick === 'Configure' && vscode.commands.executeCommand('ellm.configure'));
      }
      this.log(`request failed: ${err.message}`);
      throw err;
    } finally {
      sub.dispose();
    }
  }

  /**
   * Nothing between the picker and the backend validates a model name, so asking
   * for one that does not exist gets a normal-looking answer from whatever the
   * backend falls back to. Say so out loud rather than letting a silent
   * substitution pass for a working configuration.
   */
  reportServedModel({ requested, served, matches, confirmed }) {
    if (confirmed === false) {
      // Unverifiable is not the same as correct, and it is the state a silent
      // substitution hides in - so it gets its own line rather than nothing.
      this.log(
        `served model UNCONFIRMED: no frame named a model, so "${requested}" could not be `
        + 'verified. Set "Served model path" if the backend names it somewhere this reader misses.',
      );
      return;
    }
    if (matches) {
      this.log(`served by: ${served}`);
      return;
    }

    this.log(`MODEL MISMATCH: asked for "${requested}", served by "${served}"`);
    const pair = `${requested} ${served}`;
    if (this.warnedModels.has(pair)) return;
    this.warnedModels.add(pair);

    vscode.window.showWarningMessage(
      `Enterprise LLM answered as "${served}", not the "${requested}" you picked. `
      + 'The backend does not recognise that name and substituted its default - '
      + 'check the model list in the connection panel.',
      'Configure',
    ).then((pick) => pick === 'Configure' && vscode.commands.executeCommand('ellm.configure'));
  }

  /**
   * The picked model only reaches the backend if it is sent under the key the
   * backend reads. Nothing in the response can prove it was - a backend that
   * ignores an unknown field answers perfectly well from its default - so the
   * request side is stated out loud, and a fixed model sitting in the extra
   * fields is called out as the thing that would override the picker.
   */
  reportRequestShape({ modelField, model, conflicts, url, body, headers }) {
    this.log(`requesting model "${model}" in body field "${modelField}"`);

    // Opt-in, because the body carries the identity block and this channel gets
    // pasted into chat windows. Off by default; turned on to compare against the
    // web app's payload, then turned off again.
    const mode = readSetting(this.context, 'logRequestBody');
    if (mode === 'keys' || mode === 'full') {
      this.log(`request payload (${mode}):\n${describeRequest(
        {
          url,
          body,
          headers,
          promptField: readSetting(this.context, 'promptField'),
          messagesField: readSetting(this.context, 'messagesField'),
        },
        { values: mode === 'full' },
      )}`);
    }

    if (!conflicts.length) return;

    for (const conflict of conflicts) {
      this.log(`model field conflict: ${describeConflict(conflict, modelField)}`);
    }

    const serious = conflicts.filter((c) => c.reason !== 'overridden');
    if (!serious.length) return;

    const pair = `${modelField}|${serious.map((c) => c.path).join(',')}`;
    if (this.warnedConflicts.has(pair)) return;
    this.warnedConflicts.add(pair);

    vscode.window.showWarningMessage(
      `Enterprise LLM: the picked model is sent in "${modelField}", but `
      + `${serious.map((c) => `"${c.path}"`).join(' and ')} in your extra request fields also `
      + 'names a model and never changes. If the backend reads that one, the model picker has '
      + 'no effect. Check the output channel.',
      'Configure',
    ).then((pick) => pick === 'Configure' && vscode.commands.executeCommand('ellm.configure'));
  }

  /** VS Code chat messages -> the enterprise LLM's {speaker, utterance} turns. */
  toTurns(messages, shimming) {
    const Role = vscode.LanguageModelChatMessageRole;
    const turns = [];

    for (const msg of messages) {
      let speaker = 'human';
      if (msg.role === Role.Assistant) speaker = 'assistant';
      else if (Role.System !== undefined && msg.role === Role.System) speaker = 'system';

      let text = '';
      const toolCalls = [];
      const toolResults = [];
      const images = [];

      for (const part of msg.content ?? []) {
        const piece = partToPieces(part);
        if (piece.text) text += piece.text;
        if (piece.image) images.push(piece.image);
        if (piece.toolCall) toolCalls.push(piece.toolCall);
        if (piece.toolResult) toolResults.push(piece.toolResult);
      }

      // A plain chat endpoint has no notion of tool turns, so render them as text
      // in exactly the format the shim taught the model to produce and read.
      //
      // There is no speaker for "the tool" - the backend knows human, assistant and
      // system - so a result arrives labelled as the user talking. A chat-tuned model
      // reads that as a fresh message from a person and answers it conversationally
      // ("I've read the file, shall I go on?"), which ends the turn and with it the
      // agent loop. Saying whose output this is costs one line and removes the
      // misreading; the tool prompt makes the same point from the other side.
      for (const r of toolResults) {
        turns.push({
          speaker: 'human',
          utterance: `TOOL RESULT (${r.callId}) - output of your own tool call, `
            + `not a message from the user:\n${r.content}`,
        });
      }
      if (toolCalls.length && shimming) {
        const rendered = toolCalls
          .map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.input ?? {} })}</tool_call>`)
          .join('\n');
        text = text ? `${text}\n${rendered}` : rendered;
      }
      // An image with no caption is a whole message on its own - "explain this"
      // is often typed in an earlier turn - so text is no longer what decides
      // whether the turn exists.
      if (text || images.length) turns.push({ speaker, utterance: text, images });
    }

    // Every agent round after the first ends on a tool result, and that is exactly
    // the moment the model decides whether to carry on or to hand back. Left to
    // itself it hands back, because the last thing in the prompt looks like someone
    // telling it something rather than a job half done.
    //
    // Kept to one short line, and deliberately silent about which earlier message
    // holds the request: every previous attempt to point at it ("the message above",
    // "the message that follows") was wrong for half of all requests, because the
    // request is not at a fixed distance from the end.
    const last = turns[turns.length - 1];
    if (shimming && last?.speaker === 'human' && last.utterance?.startsWith('TOOL RESULT')) {
      turns.push({
        speaker: 'human',
        utterance: 'Continue the task with the next step. Call the next tool if one is '
          + 'needed. Do not ask whether to continue.',
      });
    }

    return turns;
  }

  // --- 3. token counting -----------------------------------------------------
  async provideTokenCount(_model, text, _token) {
    // Same CHARS_PER_TOKEN as maxInputTokens above, and that is the whole point:
    // VS Code fills the context window by counting with this and comparing against
    // that, so two different divisors mean it packs to a budget nobody configured.
    if (typeof text === 'string') return Math.ceil(text.length / CHARS_PER_TOKEN);

    const pieces = (text?.content ?? []).map(partToPieces);
    const str = pieces.map((p) => p.text ?? '').join('');
    // An image costs context whether or not it costs prompt characters. Counting
    // it as zero is what lets a conversation with a few screenshots in it sail
    // past the limit while this says it is nowhere near.
    const imageChars = pieces.reduce((n, p) => n + (p.image?.data.length ?? 0), 0);
    return Math.ceil((str.length + imageChars) / CHARS_PER_TOKEN);
  }
}

module.exports = { EllmChatProvider };
