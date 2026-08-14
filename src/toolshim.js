/**
 * Tool-calling emulation for text-only upstreams (ELM_TOOL_MODE=shim).
 *
 * Agent mode only offers models that advertise tool calling, and expects structured
 * tool calls back. If your eLLM is a plain chat endpoint we
 * teach it the protocol in the system prompt and parse the tags back out of the
 * stream, so agent mode sees a normal tool-calling model.
 */

const { parseLenient } = require('./jsonRepair');

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

/**
 * Models improvise, and the protocol they were taught is only ever a suggestion.
 *
 * Measured against realistic replies, a literal `<tool_call>` match caught 6 of 13
 * shapes a chat-tuned model actually emits; the other 7 were printed into the chat
 * as raw markup and the call never ran. The variants are not exotic - they are a
 * hyphen instead of an underscore, a capital letter, a stray space, or the tags
 * dropped entirely in favour of a ```json fence, which is how a model that has
 * spent its life in a chat window writes a JSON object.
 *
 * So the tags are matched as a shape rather than a string. `tool_use` and
 * `function_call` are here because they are what the same model emits when it is
 * pattern-matching on some other vendor's protocol instead of ours.
 */
const TAG_NAME = '(?:tool[_\\- ]?call|tool[_\\- ]?use|function[_\\- ]?call)';
const OPEN_RE = new RegExp(`<\\s*${TAG_NAME}\\s*>`, 'i');
const CLOSE_RE = new RegExp(`<\\s*/\\s*${TAG_NAME}\\s*>`, 'i');

/**
 * A closing tag the model mangled, at the very end of what it wrote.
 *
 * Only trusted at end of stream: mid-stream this would eat a tag that is merely
 * still arriving.
 */
const BROKEN_CLOSE_TAIL = new RegExp(`\\s*<\\s*/?\\s*${TAG_NAME}?\\s*[^\\s<]{0,3}\\s*$`, 'i');

/** A markdown fence the model wrapped around a call despite being told not to. */
const FENCE_OPEN = /^\s*```[a-z0-9+#.\-]*[ \t]*\r?\n?/i;
const FENCE_CLOSE = /\r?\n?[ \t]*```\s*$/;
/**
 * A fence still arriving, held back so it is not emitted just before a call.
 *
 * The trailing newline is the point: `` ```json `` and `` ```json\n `` are the same
 * fence one chunk apart, and a stream that breaks between them used to emit the
 * fence as prose a moment before the call it was wrapping showed up.
 */
const FENCE_TAIL = /(?:\r?\n)?[ \t]*`{1,3}[a-z0-9+#.\-]*[ \t]*\r?\n?$/i;

/**
 * The beginning of an untagged call, before enough of it has arrived to be sure.
 *
 * Without this the whole scheme only works when a chunk boundary happens to fall in
 * a convenient place. `{"name":` is eight characters and a stream delivers three at
 * a time, so the buffer is `{"na` when it is inspected: too little for CALL_START to
 * match, and every character of it goes to the chat as prose. By the time the rest
 * arrives the leak has already happened - a chunked stream leaked the call on most
 * random chunkings while an unchunked one passed every test.
 */
const CALL_TAIL = /\{[\s"]*[a-zA-Z_]{0,20}"?\s*:?\s*$/;
/**
 * The opening fence of a block whose entire contents turned out to be a tool call.
 *
 * Distinct from FENCE_TAIL, which only fires while the fence is the last thing in
 * the buffer: by the time the call has arrived the fence is no longer at the end,
 * it is a newline back from it, and the chat is left showing a stray ```json above
 * a tool call whose text it was supposed to introduce.
 */
const FENCE_BEFORE_CALL = /(?:^|\r?\n)[ \t]*```[a-z0-9+#.\-]*[ \t]*\r?\n?$/i;
/** Its closing partner, now sitting at the front of what is left. */
const FENCE_AFTER_CALL = /^[ \t]*\r?\n?[ \t]*```[ \t]*(?:\r?\n|$)/;
/** Nothing left but a fence - the block held a call and no prose at all. */
const FENCE_ONLY = /^\s*`{1,3}[a-z0-9+#.\-]*\s*$/i;
/** As much of a closing fence as has arrived so far, and nothing else yet. */
const FENCE_AFTER_PARTIAL = /^[ \t]*\r?\n?[ \t]*`{0,2}[ \t]*$/;
/** A `<` that could be the start of an open tag that has not finished arriving. */
const TAG_TAIL = /<[a-zA-Z_\-/ ]{0,14}$/;

/**
 * The keys a model reaches for when it writes a call without being careful.
 *
 * `recipient_name` is what a model trained on a function-calling format with a
 * routing layer emits; the rest are the ordinary near-misses.
 */
const NAME_KEYS = ['name', 'tool_name', 'toolName', 'tool', 'function_name', 'recipient_name'];
const ARG_KEYS = ['arguments', 'parameters', 'args', 'input', 'parameter', 'arguments_json'];

/** An object that opens with one of those keys is a call, not prose. */
const CALL_START = new RegExp(`\\{\\s*"(?:${NAME_KEYS.join('|')})"\\s*:`);

/**
 * ...but only when it stands on its own line.
 *
 * Recognising an untagged object anywhere in a reply is what stopped calls leaking
 * as prose; it also means the model can no longer *talk* about a tool call without
 * making one. "The package.json contains {"name": "read_file"} which is confusing"
 * came out of the scanner as `The package.json contains  which is confusing` plus a
 * phantom call - the sentence silently gutted and a tool run that nobody asked for.
 *
 * A call the model intends to make is written on a line of its own. JSON sitting
 * inside a sentence, with words either side of it, is the model discussing JSON.
 * That is the whole discriminator, and it costs nothing at stream time because the
 * text before the brace has always already arrived.
 */
function atLineStart(text, index, whenExhausted = true) {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  // Ran out of buffer without deciding, which in a stream does NOT mean the start of
  // the reply: the words before the brace may have gone out in an earlier chunk,
  // leaving the buffer beginning at the brace itself. Getting this wrong put the
  // rule back to where it started - `I think {call}` was prose unchunked and a call
  // when the boundary happened to fall before the brace. The scanner passes what it
  // knows about the line it is on; a caller holding the whole text is really at the
  // start.
  return whenExhausted;
}

/** The first untagged call in `text` that stands on its own line, or null. */
function findCallStart(text, from = 0, atStart = true) {
  const re = new RegExp(CALL_START.source, 'g');
  re.lastIndex = from;
  let m = re.exec(text);
  while (m) {
    if (atLineStart(text, m.index, atStart)) return m;
    m = re.exec(text);
  }
  return null;
}

/** The same, capturing the name, so a half-arrived object can still be judged. */
const CALL_NAME = new RegExp(`\\{\\s*"(?:${NAME_KEYS.join('|')})"\\s*:\\s*"([^"\\\\\\n]{1,80})"`);

/** What a tool name can look like, for when the offered names are not known. */
const NAME_SHAPE = /^[\w.\-]+$/;

/** A namespace a model prefixes onto a tool name; never part of the real name. */
const NAME_NAMESPACE = /^(?:functions?|tools?|namespace|multi_tool_use)\./i;

/** Past this, a held-back "{"name": ..." is prose, not a tool call. */
const MAX_HOLD = 8192;

/**
 * Headroom between the backend's hard cap and the budget the model is given.
 *
 * The cap is enforced mid-word with no warning, and a model aiming at exactly the cap
 * overshoots it routinely, so the number it is told has to be the lower one.
 */
const RESPONSE_MARGIN = 500;

/**
 * How much of that budget may be file content inside a call. The rest is the JSON
 * envelope plus escaping - and escaping is the part that bites: a file thick with
 * quotes and backslashes grows on its way into a JSON string, so a body measured at
 * the full budget crosses the cap once escaped.
 */
const CALL_CONTENT_RATIO = 0.7;

/** What to ask the model for, given the backend's hard cap. */
function budgetFor(cap) {
  if (!cap || cap <= 0) return 0;
  return cap > RESPONSE_MARGIN * 2 ? cap - RESPONSE_MARGIN : Math.floor(cap / 2);
}

/**
 * @param tools        the tool schemas the client offered
 * @param budgetChars  chars this reply should stay under; 0 omits the budget rules
 */
function buildToolPrompt(tools, { budgetChars = 0 } = {}) {
  const specs = tools.map((t) => {
    const fn = t.function ?? t;
    return JSON.stringify({
      name: fn.name,
      description: fn.description ?? '',
      parameters: fn.parameters ?? { type: 'object', properties: {} },
    });
  });

  return [
    'You can call tools. The available tools are listed below, one JSON schema per line:',
    ...specs,
    '',
    'To call a tool, emit EXACTLY this and nothing else on that line:',
    `${OPEN}{"name": "<tool name>", "arguments": {<json arguments>}}${CLOSE}`,
    '',
    'Rules:',
    '- Arguments must be valid JSON matching the schema. No comments, no trailing commas.',
    // The single most common way a file-writing call arrives broken: the file body
    // goes in verbatim, quotes and all, and the whole call stops being JSON.
    '- Inside a JSON string, write a double quote as \\" and a backslash as \\\\. '
    + 'This applies to file contents too: a Python """docstring""", a Windows path, '
    + 'or code containing quotes must all be escaped.',
    '- "arguments" must be a JSON object, not a string containing JSON.',
    `- Use the tool name exactly as listed above. No "functions." prefix.`,
    '- Emit one tool call at a time. Emitting a call ends your reply on its own - the '
    + 'result comes back to you and you carry straight on.',
    '- Never wrap the tool call in markdown or code fences, and never show a call you '
    + 'are about to make as an example first.',
    // Everything else about the cap recovers from it AFTER the fact - stitching a
    // guillotined reply, dropping a restarted call, repairing the JSON a truncation
    // left behind. This is the only rule that tries to avoid the truncation, and it is
    // far cheaper than any of them: a call that fits is never split, so it never needs
    // repairing.
    ...(budgetChars ? [
      `- Keep each reply under ${budgetChars} characters. The backend stops you at a hard `
      + 'limit just above that, mid-word and without warning. The rest is recovered over '
      + 'extra round trips, so a reply that fits is both faster and safer.',
      '- A tool call must NEVER be cut off by that limit. If a call would carry more than '
      + `about ${Math.floor(budgetChars * CALL_CONTENT_RATIO)} characters of file content, `
      + 'do not write it as one call: write the first part, wait for the result, then add '
      + 'each further part with a follow-up edit or append call. Escaping makes the JSON '
      + 'longer than the content, so leave room.',
      '- Prefer editing the specific lines that change over rewriting a whole file.',
    ] : []),
    '',
    // Without this a chat-tuned model does one useful thing and then stops to check
    // in - "I've read the file. Would you like me to fix it?" - which reads as
    // politeness and is in fact the end of the turn: a reply carrying no tool call
    // ends the agent loop, so the task is abandoned and the user has to say "yes,
    // continue" to buy a single further step.
    //
    // Kept to four lines on purpose. The first version of this block ran to nine and
    // added 1202 chars to a prompt that is PREPENDED, on a backend that truncates
    // from the front - so it pushed the user's request towards the edge on every
    // turn, and the request is the one thing that must never fall off. Anything that
    // is merely nice to say belongs in the tool schemas, which are already there.
    'Working the task:',
    '- You are in an automated agent loop, not a chat. Keep going until the task is '
    + 'finished. Do not ask permission for an ordinary step - reading, searching, '
    + 'editing, running a build - just take it.',
    '- Do not stop to report progress or describe a plan. Carry it out, then report '
    + 'once at the end, and never end a turn with a question.',
    '- A message beginning "TOOL RESULT" is your own call coming back, not the user. '
    + 'Read it and continue with the next step.',
    '- If a step fails, try another way rather than handing the problem back. If no '
    + 'tool is needed, just answer in plain text.',
  ].join('\n');
}

/** Inject the tool protocol into the outgoing message list. */
function injectToolPrompt(messages, tools) {
  if (!tools?.length) return messages;
  const prompt = buildToolPrompt(tools);
  const first = messages[0];
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: prompt }, ...messages];
}

/** Index of the last open tag in `text`, or -1. Tolerant of the tag variants. */
function lastOpenIndex(text) {
  const re = new RegExp(OPEN_RE.source, 'gi');
  let last = -1;
  let m = re.exec(text);
  while (m) {
    last = m.index;
    m = re.exec(text);
  }
  return last;
}

/** Index of the first close tag at or after `from`, or -1. */
function closeIndexFrom(text, from) {
  const m = CLOSE_RE.exec(text.slice(from));
  return m ? from + m.index : -1;
}

/**
 * Whether `text` ends inside a tool call the model never closed.
 *
 * Proof the answer is unfinished, whatever the backend's stop reason claims -
 * see the continuation layer, which uses this to keep asking.
 */
function hasOpenToolCall(text) {
  const open = lastOpenIndex(text);
  return open !== -1 && closeIndexFrom(text, open) === -1;
}

/**
 * Whether a continuation round abandoned the call it was meant to finish and
 * started a fresh one.
 *
 * Asked to continue mid-JSON, a model often re-opens `<tool_call>` and writes the
 * whole call again from the top. Stitching that onto the half it already wrote
 * produces one call made of two overlapping halves - which either fails to parse
 * or, worse, parses into a file with duplicated content. The restarted call is
 * the self-consistent one, so the half before it has to go.
 */
function restartsToolCall(base, next) {
  if (!hasOpenToolCall(base)) return false;
  const openMatch = OPEN_RE.exec(next);
  if (!openMatch) return false;
  const closeMatch = CLOSE_RE.exec(next);
  return !closeMatch || closeMatch.index > openMatch.index;
}

/** A tool name reduced to what the model cannot get wrong: letters and digits. */
function normaliseToolName(name) {
  return String(name).replace(NAME_NAMESPACE, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Whether the answer stopped part-way through a call, tagged or not.
 *
 * `hasOpenToolCall` only sees a call the model tagged. A call it wrote bare - which
 * is most of them, once the reply is long enough that the model has drifted from the
 * protocol - stops the continuation layer dead: the round looks finished, the JSON is
 * left with its braces open, and the call is discarded instead of being asked for the
 * rest of itself. That is one lost step of the agent loop for every truncated call.
 *
 * The offered names are what keep this from firing on prose. An unbalanced object
 * naming a tool the client can actually run is a cut-off call; anything else is text
 * that merely contains a brace, and asking the model to continue it would waste a
 * round trip on every answer that quotes a config file.
 */
function hasUnfinishedCall(text, toolNames) {
  if (hasOpenToolCall(text)) return true;

  // Same own-line rule as the scanner: an object quoted inside a sentence is the
  // model talking about a call, and asking it to "continue" one it never started
  // costs a round trip on every answer that happens to mention JSON.
  let start = -1;
  for (let m = findCallStart(text); m; m = findCallStart(text, m.index + 1)) start = m.index;
  if (start === -1 || objectEnd(text, start) !== -1) return false;

  const named = CALL_NAME.exec(text.slice(start, start + 256));
  if (!named) return false;
  const wanted = normaliseToolName(named[1].trim());
  return (toolNames ?? []).some((n) => normaliseToolName(n) === wanted);
}

/** `text` with the unfinished tool call at its end removed. */
function dropOpenToolCall(text) {
  const open = lastOpenIndex(text);
  return open === -1 ? text : text.slice(0, open);
}

/**
 * What the chat shows in place of a tool call that could not be run.
 *
 * Not the call itself: it is routinely a whole source file, and a chat window
 * full of raw markup tells the user nothing while burying the answer. It is
 * addressed to the model as much as to the user - VS Code replays this text as
 * the previous assistant turn, so it is also the only chance the model gets to
 * find out the call never ran and write it differently.
 */
function unparsedNotice(raw, closed) {
  const head = raw.slice(0, 160).replace(/\s+/g, ' ').trim();
  return `\n\n**A tool call could not be run** - ${closed
    ? 'its arguments were not valid JSON'
    : `it stopped before it finished (${raw.length} chars)`}, so nothing was `
    + 'written or read. Send it again as a single valid JSON object: escape every `"` as '
    + '`\\"` and every `\\` as `\\\\` inside strings, and if it carries a large file, write '
    + `it in smaller pieces.\n\n> starts: \`${head}\`\n\n`;
}

/** How many trailing chars of `buf` must be held back rather than emitted as text. */
function holdTail(buf) {
  for (const re of [TAG_TAIL, FENCE_TAIL, CALL_TAIL]) {
    const m = re.exec(buf);
    if (!m) continue;
    let idx = m.index;

    // A fence sitting immediately before a call that has begun to arrive has to be
    // held with it. On its own the fence is only held while it is the last thing in
    // the buffer, so the first character of the call released it - and by the time
    // the call was recognised and its fence stripped, that fence had already gone
    // to the chat, one chunk earlier, as prose.
    if (re !== FENCE_TAIL) {
      const fence = FENCE_BEFORE_CALL.exec(buf.slice(0, idx));
      if (fence) idx = fence.index;
    }

    // Held only while it is plausibly the start of something; a brace that never
    // becomes a call is released by the next chunk, or at the latest by flush().
    if (buf.length - idx <= MAX_HOLD) return buf.length - idx;
  }
  return 0;
}

/**
 * The end of the JSON object starting at `from`, or -1 if it has not all arrived.
 *
 * Brace counting, but string-aware: a `}` inside a file body is not the end of the
 * call, and a model writing a shell snippet or a CSS block puts plenty of them there.
 */
function objectEnd(text, from) {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Strip a markdown fence the model wrapped around a call. */
function unfence(raw) {
  return raw.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '').trim();
}

/** Prose that precedes a call, without the fence that was only there to wrap it. */
function stripFenceBefore(text) {
  return text.replace(FENCE_BEFORE_CALL, '');
}

/**
 * Streaming splitter: feed it upstream text, get back user-visible text plus any
 * completed tool calls, without ever leaking a half-written tag to the client.
 */
class ToolCallScanner {
  #buf = '';
  #inCall = false;
  /** A wrapping fence was stripped; the call it wraps has not finished arriving. */
  #fencePending = false;
  /** ...and now it has, so that fence's closing half is still to come. */
  #fenceOpen = false;
  #seq = 0;
  /**
   * Whether the next character to leave the buffer would begin a line.
   *
   * The own-line rule that separates a real untagged call from prose about one can
   * only be applied against the whole reply, and the buffer is a window onto it -
   * so what has already been emitted has to be remembered here.
   */
  #lineStart = true;
  /**
   * A call start already accepted, whose object is still arriving.
   *
   * Once the own-line rule has said yes, the answer has to survive the next chunk.
   * Re-deriving it fails on the fenced case: stripping the wrapping ```json takes
   * the newline that put the call on its own line with it, so the continuation
   * chunk sees a bare `{` with no line in front of it and lets the call through as
   * prose.
   */
  #callPending = false;
  #onProblem;
  #known;

  /**
   * `onProblem` is told about a tool call that would not parse. Without it the
   * only evidence is a wall of markup in the chat, which says nothing about
   * whether the call was cut off mid-write or was simply not JSON - and those
   * have opposite fixes.
   *
   * `toolNames` are the tools the client actually offered. They are what makes it
   * safe to pick an *untagged* call out of the middle of prose: `{"name": ...}`
   * on its own is ambiguous - it is a tool call in an agent turn and a piece of
   * example JSON in an answer about JSON - and the only thing that separates them
   * is whether the name is one the client can actually run. With no names given,
   * the shape has to carry the decision alone.
   */
  constructor(onProblem, toolNames) {
    this.#onProblem = onProblem || (() => {});
    this.#known = new Map((toolNames ?? []).map((n) => [normaliseToolName(n), n]));
  }

  /** Remember whether emitted text left us mid-line, for the own-line rule. */
  #noteEmitted(text) {
    if (!text) return;
    const nl = text.lastIndexOf('\n');
    if (nl !== -1) this.#lineStart = true;
    const tail = nl === -1 ? text : text.slice(nl + 1);
    if (/[^ \t\r]/.test(tail)) this.#lineStart = false;
  }

  /** The offered tool `name` refers to, or null when it refers to none. */
  #resolveName(name) {
    if (!this.#known.size) return name;
    return this.#known.get(normaliseToolName(name)) ?? null;
  }

  /**
   * Whether text that opens like a call but has not closed really is one.
   *
   * `{"name": ...` is not enough on its own. An answer can legitimately begin with
   * a brace - the model quoting a config file, or writing about JSON - and if that
   * counts as a truncated call the whole answer is replaced by a notice saying a
   * tool call failed, which is both wrong and unrecoverable: the text is gone.
   *
   * The name settles it. A real call names a tool the client offered; prose puts a
   * sentence there, or nothing quoted at all. With no offered names to check
   * against, the shape of the name has to stand in - a tool is an identifier, not
   * a phrase with spaces in it.
   */
  #looksLikeCall(text) {
    const m = CALL_NAME.exec(text.slice(0, 256));
    if (!m) return false;
    const name = m[1].trim();
    return this.#known.size ? Boolean(this.#resolveName(name)) : NAME_SHAPE.test(name);
  }

  /**
   * Prose before a call, minus a fence that was only wrapping the call - and a note
   * to expect that fence's closing half in some later chunk.
   */
  #takeFenceBefore(before) {
    const stripped = stripFenceBefore(before);
    if (stripped !== before) this.#fencePending = true;
    return stripped;
  }

  /**
   * A call has finished arriving, so a fence stripped ahead of it is now a fence
   * waiting to be closed.
   *
   * The two states have to be separate. Looking for the closing half while the call
   * itself is still streaming means looking at a buffer full of JSON, deciding no
   * fence is coming, and forgetting there was ever a fence at all - which left the
   * closing ``` to reach the chat as an empty code block under exactly the chunk
   * boundaries that a whole-string test never produces.
   */
  #callDone() {
    this.#fenceOpen = this.#fencePending;
    this.#fencePending = false;
  }

  /** Why a call did not parse, in one line, with enough of it to tell. */
  #reportUnparsed(raw, closed) {
    const head = raw.slice(0, 200).replace(/\s+/g, ' ');
    const tail = raw.length > 200 ? raw.slice(-120).replace(/\s+/g, ' ') : '';
    const balance = [...raw].reduce((n, c) => n + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);

    this.#onProblem(
      `tool call not parsed (${raw.length} chars, ${closed ? 'closed' : 'NEVER CLOSED'}, `
      + `${balance > 0 ? `${balance} brace(s) still open` : 'braces balanced'}). `
      + `It was shown in the chat as text instead of being run.\n  starts: ${head}`
      + (tail ? `\n  ends: ...${tail}` : ''),
    );
  }

  push(chunk) {
    this.#buf += chunk;
    let text = '';
    const calls = [];
    // Every emission goes through here so the own-line rule keeps its place in the
    // reply across chunk boundaries.
    const emit = (s) => { if (s) { text += s; this.#noteEmitted(s); } };

    for (;;) {
      if (this.#inCall) {
        const m = CLOSE_RE.exec(this.#buf);
        if (!m) break; // wait for the rest of the call, or for flush()
        const raw = this.#buf.slice(0, m.index);
        this.#buf = this.#buf.slice(m.index + m[0].length);
        this.#inCall = false;
        this.#callDone();

        const found = this.#toCalls(raw);
        if (found.length) calls.push(...found);
        else {
          // Malformed call - tell the model it never ran so it can self-correct,
          // and put the reason in the log, where it is actually readable.
          this.#reportUnparsed(raw, true);
          emit(unparsedNotice(raw, true));
        }
        continue;
      }

      // A fence whose opening was swallowed because it was only there to wrap a
      // call has a closing half still to come, and it usually arrives in a later
      // chunk than the call did - so it cannot be dealt with at the same moment.
      // Left alone it shows up in the chat as an empty code block.
      if (this.#fenceOpen) {
        const close = FENCE_AFTER_CALL.exec(this.#buf);
        if (close) {
          this.#buf = this.#buf.slice(close[0].length);
          this.#fenceOpen = false;
          continue;
        }
        if (FENCE_AFTER_PARTIAL.test(this.#buf)) break; // still arriving
        this.#fenceOpen = false; // whatever followed, it was not a closing fence
      }

      const open = OPEN_RE.exec(this.#buf);
      if (open) {
        // A fence the model opened purely to wrap the call is not prose, and
        // emitting it leaves a stray ``` sitting above the tool call in the chat.
        emit(this.#takeFenceBefore(this.#buf.slice(0, open.index)));
        this.#buf = this.#buf.slice(open.index + open[0].length);
        this.#inCall = true;
        continue;
      }

      // No tags at all. The call may still be in there: a model that has spent its
      // life in a chat window writes JSON in a ```json fence, or bare, wherever it
      // happens to be in the reply - not only at the very start.
      const untagged = this.#takeUntagged();
      if (untagged) {
        emit(untagged.text);
        calls.push(...untagged.calls);
        if (untagged.wait) break;
        continue;
      }

      const hold = holdTail(this.#buf);
      emit(this.#buf.slice(0, this.#buf.length - hold));
      this.#buf = hold ? this.#buf.slice(this.#buf.length - hold) : '';
      break;
    }

    return { text, calls };
  }

  /**
   * Pull an untagged call out of the buffer, if there is a whole one in there.
   *
   * `wait` says a call has started but not finished arriving: the prose before it
   * is safe to emit, the call itself is not, and putting half an object into the
   * chat as prose is exactly the leak this class exists to prevent.
   */
  #takeUntagged() {
    const m = findCallStart(this.#buf, 0, this.#lineStart || this.#callPending);
    if (!m) return null;

    const end = objectEnd(this.#buf, m.index);
    if (end === -1) {
      // Still arriving - unless it has gone on so long that it was never a call.
      if (this.#buf.length - m.index > MAX_HOLD) return null;
      // Once the name has fully arrived it can be judged, and prose that merely
      // opens with a brace is let go now rather than stalling the answer until the
      // stream ends. Before the name closes its quote there is nothing to judge, so
      // it keeps being held: releasing it there is the partial-object leak.
      const rest = this.#buf.slice(m.index);
      if (CALL_NAME.test(rest.slice(0, 256)) && !this.#looksLikeCall(rest)) {
        this.#callPending = false;
        return null;
      }
      // Through #takeFenceBefore, not stripFenceBefore: the wrapping fence is being
      // swallowed here, so its closing half has to be remembered here too. Doing it
      // only on the path where the whole call arrives at once means a call split
      // across chunks - which is most of them - strips the opening fence and then
      // has no idea the closing one is coming, and it lands in the chat as an empty
      // code block. 2725 of 3160 possible splits of one fenced call leaked it.
      const before = this.#takeFenceBefore(this.#buf.slice(0, m.index));
      this.#buf = this.#buf.slice(m.index);
      this.#callPending = true;
      return { text: before, calls: [], wait: true };
    }

    const found = this.#toCalls(this.#buf.slice(m.index, end));
    // Not a call after all (an unknown name, or example JSON in an answer about
    // JSON) - leave it in the buffer as the prose it is.
    if (!found.length) {
      this.#callPending = false;
      return null;
    }

    const text = this.#takeFenceBefore(this.#buf.slice(0, m.index));
    this.#buf = this.#buf.slice(end);
    this.#callPending = false;
    this.#callDone();
    return { text, calls: found };
  }

  /**
   * End of stream, so whatever is still buffered has to be decided now: a call the
   * model closed badly - or never closed - is salvaged, anything else is text.
   */
  flush() {
    const buf = this.#buf;
    const inCall = this.#inCall;
    this.#buf = '';
    this.#inCall = false;
    this.#lineStart = true;
    this.#callPending = false;
    if (!buf) return { text: '', calls: [] };
    // The other half of a fence whose contents became a tool call. On its own it is
    // an empty code block in the chat, which looks like output that went missing.
    if (!inCall && FENCE_ONLY.test(buf)) return { text: '', calls: [] };

    const found = this.#toCalls(inCall ? buf.replace(BROKEN_CLOSE_TAIL, '') : buf);
    if (found.length) return { text: '', calls: found };

    // A call still open at end of stream was cut off rather than mis-written -
    // the upstream response cap lands mid-JSON on any sizeable file. An untagged
    // call left waiting in the buffer is the same event without the tags: it opened
    // with a tool name and never closed its brace, so it is a guillotined call and
    // not prose, and dumping its JSON into the chat helps nobody.
    const wasCall = inCall || this.#looksLikeCall(buf);
    if (wasCall) this.#reportUnparsed(buf, false);
    return { text: wasCall ? unparsedNotice(buf, false) : buf, calls: [] };
  }

  /**
   * Forget the call currently being written, without emitting it.
   *
   * Used when the model restarts a call it left half-finished: the half in the
   * buffer is dead weight that would otherwise be spliced onto the new one.
   */
  dropOpenCall() {
    if (!this.#inCall) return;
    this.#buf = '';
    this.#inCall = false;
  }

  /**
   * The tool calls in raw JSON - usually one, none if it is not a call at all.
   *
   * Repairing before giving up matters most on Windows. A model writing
   * `{"filePath":"c:\Users\dev\notes.md"}` has produced invalid JSON - `\U` is not
   * an escape sequence - so a strict parse throws and the call is shown to the
   * user as text instead of being run. The file edit silently never happens, the
   * model is told nothing, and it tries the same edit again. Every tool call
   * carrying a Windows path fails this way.
   */
  #toCalls(raw) {
    const parsed = parseLenient(unfence(raw))?.value;
    if (!parsed) return [];
    // Some models answer with a list when they mean to make one call.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item) => this.#toCall(item)).filter(Boolean);
  }

  /** One normalised call, or null if `parsed` is not one. */
  #toCall(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    // The OpenAI envelope, emitted verbatim by a model that has seen a lot of it.
    const src = (parsed.function && typeof parsed.function === 'object')
      ? { ...parsed, ...parsed.function }
      : parsed;

    const rawName = NAME_KEYS.map((k) => src[k]).find((v) => typeof v === 'string' && v.trim());
    if (!rawName) return null;

    const name = this.#resolveName(rawName.trim());
    if (!name) return null;

    return {
      index: this.#seq,
      id: `call_${Date.now()}_${this.#seq++}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(this.#argsOf(src)) },
    };
  }

  /**
   * The arguments object, whatever the model wrapped it in.
   *
   * The one that actually breaks tools is `"arguments": "{\"path\": \"a.js\"}"` -
   * a JSON *string* holding JSON. It parses perfectly, so nothing looks wrong, and
   * VS Code is then handed a string where the tool's schema says object: the call
   * is rejected or the tool reads every field as undefined. Silent, and it looks
   * from the chat like the model simply used the tool wrong.
   */
  #argsOf(src) {
    for (const key of ARG_KEYS) {
      const value = src[key];
      if (value == null) continue;
      if (typeof value === 'object') return value;
      if (typeof value === 'string') {
        if (!value.trim()) return {};
        const inner = parseLenient(value.trim())?.value;
        if (inner && typeof inner === 'object') return inner;
      }
    }
    return {};
  }
}

module.exports = {
  buildToolPrompt,
  budgetFor,
  injectToolPrompt,
  ToolCallScanner,
  hasOpenToolCall,
  hasUnfinishedCall,
  normaliseToolName,
  restartsToolCall,
  dropOpenToolCall,
  unparsedNotice,
};
