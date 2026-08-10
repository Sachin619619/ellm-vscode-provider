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
 * Models improvise. Two failures show up often enough to handle rather than
 * hand to the user as raw markup:
 *   - the closing tag comes back mangled ("</tool_call}", or missing entirely)
 *   - the tags are skipped and the whole answer is the bare JSON object
 */
const BROKEN_CLOSE_TAIL = /\s*<\/?\s*tool_call\s*[^\s<]{0,3}\s*$/i;
const BARE_CALL_START = /^\s*\{\s*"name"\s*:/;
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
    '- Emit one tool call at a time, then stop and wait for the result.',
    '- Never wrap the tool call in markdown or code fences.',
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
    '- If no tool is needed, just answer normally in plain text.',
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

/**
 * Whether `text` ends inside a tool call the model never closed.
 *
 * Proof the answer is unfinished, whatever the backend's stop reason claims -
 * see the continuation layer, which uses this to keep asking.
 */
function hasOpenToolCall(text) {
  const open = text.lastIndexOf(OPEN);
  return open !== -1 && text.indexOf(CLOSE, open) === -1;
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
  const open = next.indexOf(OPEN);
  if (open === -1) return false;
  const close = next.indexOf(CLOSE);
  return close === -1 || close > open;
}

/** `text` with the unfinished tool call at its end removed. */
function dropOpenToolCall(text) {
  const open = text.lastIndexOf(OPEN);
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

/** How many trailing chars of `buf` could be the start of `tag`. */
function partialTagTail(buf, tag) {
  for (let i = Math.min(buf.length, tag.length - 1); i > 0; i--) {
    if (buf.endsWith(tag.slice(0, i))) return i;
  }
  return 0;
}

/**
 * Streaming splitter: feed it upstream text, get back user-visible text plus any
 * completed tool calls, without ever leaking a half-written tag to the client.
 */
class ToolCallScanner {
  #buf = '';
  #inCall = false;
  #seq = 0;
  #emitted = false;
  #onProblem;

  /**
   * `onProblem` is told about a tool call that would not parse. Without it the
   * only evidence is a wall of markup in the chat, which says nothing about
   * whether the call was cut off mid-write or was simply not JSON - and those
   * have opposite fixes.
   */
  constructor(onProblem) {
    this.#onProblem = onProblem || (() => {});
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

    for (;;) {
      if (this.#inCall) {
        const idx = this.#buf.indexOf(CLOSE);
        if (idx === -1) break; // wait for the rest of the call, or for flush()
        const raw = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + CLOSE.length);
        this.#inCall = false;

        const call = this.#toCall(raw);
        if (call) calls.push(call);
        else {
          // Malformed call - tell the model it never ran so it can self-correct,
          // and put the reason in the log, where it is actually readable.
          this.#reportUnparsed(raw, true);
          text += unparsedNotice(raw, true);
        }
        continue;
      }

      const idx = this.#buf.indexOf(OPEN);
      if (idx !== -1) {
        text += this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + OPEN.length);
        this.#inCall = true;
        continue;
      }

      // An answer that opens with `{"name":` is almost certainly a tool call the
      // model forgot to tag. Hold it back instead of streaming half an object out
      // as prose - once it parses it becomes a call, and if it never does, flush()
      // releases it as the text it turned out to be.
      if (!this.#emitted && !text && this.#buf.length <= MAX_HOLD && BARE_CALL_START.test(this.#buf)) {
        const call = this.#toCall(this.#buf);
        if (!call) break;
        calls.push(call);
        this.#buf = '';
        continue;
      }

      const hold = partialTagTail(this.#buf, OPEN);
      text += this.#buf.slice(0, this.#buf.length - hold);
      this.#buf = hold ? this.#buf.slice(this.#buf.length - hold) : '';
      break;
    }

    if (text) this.#emitted = true;
    return { text, calls };
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
    this.#emitted = true;
    if (!buf) return { text: '', calls: [] };

    const call = this.#toCall(inCall ? buf.replace(BROKEN_CLOSE_TAIL, '') : buf);
    if (call) return { text: '', calls: [call] };
    // A call still open at end of stream was cut off rather than mis-written -
    // the upstream response cap lands mid-JSON on any sizeable file.
    if (inCall) this.#reportUnparsed(buf, false);
    return { text: inCall ? unparsedNotice(buf, false) : buf, calls: [] };
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
   * A tool call from raw JSON, or null if it is not one.
   *
   * Repairing before giving up matters most on Windows. A model writing
   * `{"filePath":"c:\Users\dev\notes.md"}` has produced invalid JSON - `\U` is not
   * an escape sequence - so a strict parse throws and the call is shown to the
   * user as text instead of being run. The file edit silently never happens, the
   * model is told nothing, and it tries the same edit again. Every tool call
   * carrying a Windows path fails this way.
   */
  #toCall(raw) {
    const parsed = parseLenient(raw.trim())?.value;
    if (!parsed || typeof parsed.name !== 'string') return null;

    return {
      index: this.#seq,
      id: `call_${Date.now()}_${this.#seq++}`,
      type: 'function',
      function: {
        name: parsed.name,
        arguments: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}),
      },
    };
  }
}

module.exports = {
  buildToolPrompt,
  budgetFor,
  injectToolPrompt,
  ToolCallScanner,
  hasOpenToolCall,
  restartsToolCall,
  dropOpenToolCall,
  unparsedNotice,
};
