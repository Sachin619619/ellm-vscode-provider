const vscode = require('vscode');
const { CorpClient, CorpAuthError, describeConflict, describeRequest } = require('./corpClient');
const { withContinuation } = require('./continuation');
const { buildToolPrompt, ToolCallScanner } = require('./toolshim');
const { getToken, getCookie, getPrivate, readSetting } = require('./storage');

/** Read a VS Code message part without depending on class identity across API versions. */
function partToPieces(part) {
  if (typeof part === 'string') return { text: part };
  if (part == null) return {};
  if (typeof part.value === 'string') return { text: part.value };
  if (part.name && 'input' in part) {
    return { toolCall: { callId: part.callId, name: part.name, input: part.input } };
  }
  if ('callId' in part && 'content' in part) {
    const content = Array.isArray(part.content)
      ? part.content.map((c) => (typeof c === 'string' ? c : c?.value ?? '')).join('')
      : String(part.content ?? '');
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
      url: readSetting(this.context, 'url', ''),
      token: await getToken(this.context),
      cookie: await getCookie(this.context),
      authHeader: readSetting(this.context, 'authHeader', 'X-Corp-Auth'),
      authPrefix: readSetting(this.context, 'authPrefix', ''),
      chatPath: readSetting(this.context, 'chatPath', '/chat'),
      promptField: readSetting(this.context, 'promptField', 'prompt'),
      modelField: readSetting(this.context, 'modelField', 'model'),
      models: String(readSetting(this.context, 'models', ''))
        .split(',').map((s) => s.trim()).filter(Boolean),
      textPath: readSetting(this.context, 'textPath', ''),
      servedModelPath: readSetting(this.context, 'servedModelPath', ''),
      maxResponseChars: readSetting(this.context, 'maxResponseChars', 5000),
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
      this.log(`discovered ${info.models.length} model(s), upstream cap ${cap} chars`);

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
        maxInputTokens: Math.floor((m.contextChars ?? 400000) / 4),
        // Deliberately far above the upstream's per-response cap: the continuation
        // layer stitches capped rounds into one answer.
        maxOutputTokens: 32000,
        tooltip: `Enterprise LLM via ${client.url}`,
        detail: `${cap}-char cap, auto-continued`,
        capabilities: { toolCalling: true, imageInput: false },
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

    const turns = this.toTurns(messages, shimming);
    if (shimming) turns.unshift({ speaker: 'system', utterance: buildToolPrompt(tools) });

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());

    const scanner = shimming ? new ToolCallScanner() : null;
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
        maxResponseChars: readSetting(this.context, 'maxResponseChars', 5000),
        maxContinuations: readSetting(this.context, 'maxContinuations', 8),
        signal: controller.signal,
        log: (m) => this.log(m),
      });

      const emit = ({ text, calls: found }) => {
        if (text) {
          chars += text.length;
          progress.report(new vscode.LanguageModelTextPart(text));
        }
        for (const c of found) {
          calls++;
          progress.report(new vscode.LanguageModelToolCallPart(
            c.id,
            c.function.name,
            JSON.parse(c.function.arguments || '{}'),
          ));
        }
      };

      for await (const ev of stream) {
        if (token.isCancellationRequested) break;
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
    const mode = readSetting(this.context, 'logRequestBody', 'off');
    if (mode === 'keys' || mode === 'full') {
      this.log(`request payload (${mode}):\n${describeRequest(
        { url, body, headers, promptField: readSetting(this.context, 'promptField', 'prompt') },
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

      for (const part of msg.content ?? []) {
        const piece = partToPieces(part);
        if (piece.text) text += piece.text;
        if (piece.toolCall) toolCalls.push(piece.toolCall);
        if (piece.toolResult) toolResults.push(piece.toolResult);
      }

      // A plain chat endpoint has no notion of tool turns, so render them as text
      // in exactly the format the shim taught the model to produce and read.
      for (const r of toolResults) {
        turns.push({ speaker: 'human', utterance: `TOOL RESULT (${r.callId}):\n${r.content}` });
      }
      if (toolCalls.length && shimming) {
        const rendered = toolCalls
          .map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.input ?? {} })}</tool_call>`)
          .join('\n');
        text = text ? `${text}\n${rendered}` : rendered;
      }
      if (text) turns.push({ speaker, utterance: text });
    }

    return turns;
  }

  // --- 3. token counting -----------------------------------------------------
  async provideTokenCount(_model, text, _token) {
    const str = typeof text === 'string'
      ? text
      : (text?.content ?? []).map((p) => partToPieces(p).text ?? '').join('');
    return Math.ceil(str.length / 4);
  }
}

module.exports = { EllmChatProvider };
