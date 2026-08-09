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

function buildToolPrompt(tools) {
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
        // Malformed call - surface it as text so the model can self-correct.
        else text += `${OPEN}${raw}${CLOSE}`;
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
    return { text: inCall ? OPEN + buf : buf, calls: [] };
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

module.exports = { buildToolPrompt, injectToolPrompt, ToolCallScanner };
