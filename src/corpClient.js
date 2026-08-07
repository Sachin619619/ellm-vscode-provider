/**
 * Speaks the enterprise LLM's own protocol. Nothing here is OpenAI-shaped.
 *
 *   POST {url}{chatPath}
 *   header  <authHeader>: <authPrefix><token>      + an optional Cookie header
 *   body    { <promptField>, model, stream, …whatever else is configured }
 *   SSE     text/event-stream, frame shape discovered at runtime
 *
 * EVERY value this file needs - endpoint, path, header names, credentials, model
 * name, the identity block the backend expects - arrives as configuration. There
 * are no company values in this code, on purpose: the code stays plain and
 * shareable, and the confidential parts live only in VS Code's own storage on the
 * machine that entered them.
 *
 * The provider above only consumes {type:'text'|'finish'} events, so this is the
 * one file that changes when the backend does.
 */

class CorpAuthError extends Error {}

const DEFAULT_AUTH_HEADER = 'X-Corp-Auth';
const DEFAULT_CHAT_PATH = '/chat';
const DEFAULT_PROMPT_FIELD = 'prompt';

/**
 * Where a streamed frame keeps its text. Backends disagree, so try the shapes that
 * exist in the wild, cheapest first. `ellm.textPath` overrides all of this when the
 * real frame is known - guessing is a fallback, not the design.
 */
const TEXT_PATHS = [
  'payload.deltaText', 'delta.text', 'delta.content', 'delta',
  'text', 'content', 'message', 'answer', 'completion', 'response', 'output',
  'choices.0.delta.content', 'choices.0.text', 'data',
];

const FINISH_KEYS = ['stopReason', 'stop_reason', 'finishReason', 'finish_reason'];
/** Frame-level markers that mean "the answer was cut short, ask for the rest". */
const TRUNCATED = /^(charlimit|length|max_tokens|max_output_tokens|truncated)$/i;

function dig(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** The text carried by one parsed frame, or '' if it carries none. */
function textFrom(frame, override) {
  if (typeof frame === 'string') return frame;
  if (!frame || typeof frame !== 'object') return '';

  if (override) {
    const found = dig(frame, override);
    return typeof found === 'string' ? found : '';
  }
  for (const path of TEXT_PATHS) {
    const found = dig(frame, path);
    if (typeof found === 'string' && found) return found;
  }
  return '';
}

/** 'stop' | 'length' | undefined - whether the backend says it stopped early. */
function finishFrom(frame) {
  if (!frame || typeof frame !== 'object') return undefined;
  for (const key of FINISH_KEYS) {
    const value = frame[key];
    if (typeof value === 'string' && value) return TRUNCATED.test(value) ? 'length' : 'stop';
  }
  if (frame.done === true || frame.event === 'complete' || frame.event === 'end') return 'stop';
  return undefined;
}

/**
 * A 401 from the wrong URL is indistinguishable from a 401 from a bad token, and
 * that difference is the entire diagnosis. So report what actually came back
 * rather than assuming the token is at fault.
 */
async function failureFor(res, url, client) {
  const body = (await res.text().catch(() => '')).trim();
  const contentType = res.headers?.get?.('content-type') || '';
  const isHtml = /text\/html/i.test(contentType) || /^<!doctype html|^<html/i.test(body);
  const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
  const where = `${res.status} from ${url}`;

  if (res.status === 404 || res.status === 405) {
    return new Error(`No such endpoint (${where}). Check the chat path in the connection panel.`);
  }

  if (res.status === 401 || res.status === 403) {
    if (isHtml) {
      return new CorpAuthError(
        `The endpoint answered with a web page rather than an API response (${where}). Either the `
        + 'sign-in expired, or a cookie the gateway wants is missing - re-copy both the token and '
        + 'the Cookie header from a fresh request.',
      );
    }
    return new CorpAuthError(
      `Token rejected (${where})${snippet ? `. Server said: ${snippet}` : ''}. These tokens are `
      + `short-lived; re-copy it from a current request. Sent in "${client.authHeader}"`
      + `${client.cookie ? ' with a Cookie header' : ' with no Cookie header - the gateway may need one'}.`,
    );
  }

  return new Error(`Enterprise LLM returned ${where}${snippet ? `: ${snippet}` : ''}`);
}

class CorpClient {
  constructor({
    url, token, authHeader, authPrefix, cookie, chatPath, promptField,
    model, models, identity, params, textPath, contextChars, maxResponseChars,
  } = {}) {
    // Which body key carries the prompt is the backend's business, not this file's.
    this.promptField = promptField || DEFAULT_PROMPT_FIELD;
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token || '';
    this.authHeader = authHeader || DEFAULT_AUTH_HEADER;
    this.authPrefix = authPrefix || '';
    this.cookie = cookie || '';
    this.chatPath = chatPath || DEFAULT_CHAT_PATH;
    this.model = model || '';
    this.models = models || [];
    this.identity = identity || {};
    this.params = params || {};
    this.textPath = textPath || '';
    this.contextChars = contextChars || 400000;
    this.maxResponseChars = maxResponseChars || 5000;
  }

  get configured() {
    return Boolean(this.url && this.token);
  }

  get endpoint() {
    return `${this.url}${this.chatPath.startsWith('/') ? '' : '/'}${this.chatPath}`;
  }

  /** Headers a browser would have sent; some gateways check Origin and Referer. */
  headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      'x-requested-with': 'XMLHttpRequest',
      [this.authHeader]: `${this.authPrefix}${this.token}`,
    };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.url) {
      headers.origin = this.url;
      headers.referer = `${this.url}/`;
    }
    return headers;
  }

  /**
   * No discovery endpoint: the backend serves whichever model the body names, so
   * the list is configuration. Nothing is contacted here.
   */
  async listModels() {
    const names = this.models.length ? this.models : [this.model].filter(Boolean);
    return {
      models: names.map((name) => ({ alias: name, label: name, contextChars: this.contextChars })),
      limits: { maxResponseChars: this.maxResponseChars },
    };
  }

  /**
   * The backend takes one prompt string, not a message list - it keeps history
   * itself, keyed by conversation id. VS Code already replays the whole
   * conversation every turn, so history is flattened in here and server-side
   * memory is left off; otherwise every turn would be remembered twice.
   */
  toPrompt(turns) {
    const label = { system: 'System', human: 'User', assistant: 'Assistant' };
    if (turns.length === 1) return turns[0].utterance ?? '';
    return turns
      .map((t) => `${label[t.speaker] ?? 'User'}: ${t.utterance ?? ''}`)
      .join('\n\n');
  }

  body({ modelAlias, turns }) {
    return {
      ...this.identity, // whatever extra fields the backend expects, verbatim
      ...this.params, // tuning knobs, exactly as configured
      model: modelAlias || this.model,
      [this.promptField]: this.toPrompt(turns),
      stream: true,
    };
  }

  /** Yields { type:'text', text } then a final { type:'finish', reason }. */
  async *converse({ modelAlias, turns, signal, onRawFrame }) {
    const url = this.endpoint;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body({ modelAlias, turns })),
      signal,
    });

    if (!res.ok) throw await failureFor(res, url, this);
    if (!res.body) throw new Error(`${url} answered ${res.status} with no body to stream.`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finish;
    let sawText = false;
    let reportedRaw = false;
    let firstRaw = '';

    const handle = (raw) => {
      const events = [];
      if (!raw || raw === '[DONE]' || raw === 'EOM') {
        if (raw) finish = finish ?? 'stop';
        return events;
      }

      // The first frame is logged verbatim: when the shape is not what this file
      // expects, that one line is the whole diagnosis.
      if (!reportedRaw) {
        reportedRaw = true;
        firstRaw = raw.slice(0, 400);
        if (onRawFrame) onRawFrame(firstRaw);
      }

      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        // Not JSON - a plain-text stream is a legitimate shape, so pass it through.
        events.push({ type: 'text', text: raw });
        sawText = true;
        return events;
      }

      const text = textFrom(frame, this.textPath);
      if (text) {
        events.push({ type: 'text', text });
        sawText = true;
      }
      finish = finishFrom(frame) ?? finish;
      return events;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(':') || /^(event|id|retry):/.test(line)) continue;
        for (const ev of handle(line.startsWith('data:') ? line.slice(5).trim() : line)) yield ev;
      }
    }
    if (buffer.trim()) {
      const rest = buffer.trim();
      for (const ev of handle(rest.startsWith('data:') ? rest.slice(5).trim() : rest)) yield ev;
    }

    if (!sawText) {
      // Carry the frame in the error itself. Telling someone to go and find it in an
      // output channel is one step too many when the answer is right here.
      throw new Error(
        'The endpoint streamed a response, but none of the fields this extension knows about '
        + 'held any text. Set "Text field path" to the key holding it, from this first frame:\n\n'
        + `${firstRaw || '(the stream was empty)'}`,
      );
    }

    yield { type: 'finish', reason: finish };
  }
}

module.exports = { CorpClient, CorpAuthError, textFrom, finishFrom };
