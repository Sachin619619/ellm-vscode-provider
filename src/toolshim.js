/**
 * Tool-calling emulation for text-only upstreams (ELM_TOOL_MODE=shim).
 *
 * Agent mode only offers models that advertise tool calling, and expects structured
 * tool calls back. If your eLLM is a plain chat endpoint we
 * teach it the protocol in the system prompt and parse the tags back out of the
 * stream, so agent mode sees a normal tool-calling model.
 */

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

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

  push(chunk) {
    this.#buf += chunk;
    let text = '';
    const calls = [];

    for (;;) {
      if (!this.#inCall) {
        const idx = this.#buf.indexOf(OPEN);
        if (idx === -1) {
          const hold = partialTagTail(this.#buf, OPEN);
          text += this.#buf.slice(0, this.#buf.length - hold);
          this.#buf = hold ? this.#buf.slice(this.#buf.length - hold) : '';
          break;
        }
        text += this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + OPEN.length);
        this.#inCall = true;
      } else {
        const idx = this.#buf.indexOf(CLOSE);
        if (idx === -1) break; // wait for the rest of the call
        const raw = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + CLOSE.length);
        this.#inCall = false;

        try {
          const parsed = JSON.parse(raw.trim());
          calls.push({
            index: this.#seq,
            id: `call_${Date.now()}_${this.#seq++}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}),
            },
          });
        } catch {
          // Malformed call - surface it as text so the model can self-correct.
          text += `${OPEN}${raw}${CLOSE}`;
        }
      }
    }

    return { text, calls };
  }

  /** Anything still buffered at end of stream is plain text. */
  flush() {
    const rest = this.#inCall ? OPEN + this.#buf : this.#buf;
    this.#buf = '';
    this.#inCall = false;
    return rest;
  }
}

module.exports = { buildToolPrompt, injectToolPrompt, ToolCallScanner };
