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

const { repairJson, parseLenient } = require('./jsonRepair');

class CorpAuthError extends Error {}

/**
 * Padding between frames, which is not always whitespace.
 *
 * AWS Lambda response streaming separates its `{"statusCode":...,"headers":{...}}`
 * prelude from the payload with **eight NUL bytes**. NUL is not whitespace, so
 * trimming does not remove it, and the first real frame arrives welded to it:
 * `\0\0\0\0\0\0\0\0{"completionText":"Let me ver"}`. That does not start with `{`,
 * so it misses the JSON branch entirely and gets printed as if it were prose -
 * which is why a reply would open with the envelope and then continue cleanly,
 * every time, on the first frame only.
 */
const PADDING = /^[\s\u0000-\u001f\u007f\ufeff]+/;

function stripPadding(text) {
  return text.replace(PADDING, '');
}

const DEFAULT_AUTH_HEADER = 'X-Corp-Auth';
const DEFAULT_CHAT_PATH = '/chat';
const DEFAULT_PROMPT_FIELD = 'prompt';
const DEFAULT_MODEL_FIELD = 'model';

/**
 * Where a streamed frame keeps its text. Backends disagree, so try the shapes that
 * exist in the wild, cheapest first. `ellm.textPath` overrides all of this when the
 * real frame is known - guessing is a fallback, not the design.
 */
const TEXT_PATHS = [
  'completionText', 'completion_text', 'payload.deltaText', 'delta.text', 'delta.content', 'delta',
  'text', 'content', 'message', 'answer', 'completion', 'response', 'output',
  'outputText', 'generated_text', 'choices.0.delta.content', 'choices.0.text', 'data',
];

/**
 * Pull one complete JSON value off the front of `buf`.
 *
 * Streams do not always put one frame per line - plenty concatenate objects
 * back to back, `{...}{...}`, with no separator at all. Counting braces is the
 * only way to find the boundary, and strings have to be skipped while counting
 * or a `{` inside a message ends the frame early.
 *
 * Returns {raw, rest}, or {incomplete:true} when the value is still arriving.
 */
function takeJson(buf) {
  const start = buf.search(/\S/);
  if (start === -1) return null;

  const open = buf[start];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      return { raw: buf.slice(start, i + 1), rest: buf.slice(i + 1) };
    }
  }
  return { incomplete: true };
}

/**
 * The value of the first of `keys` that appears in `raw` as a string field, read
 * straight out of the text. No parser involved: this runs precisely when parsing
 * has already failed, and on a fragment the stream ended in the middle of.
 */
function textByKey(raw, keys) {
  for (const key of keys) {
    const at = raw.indexOf(`"${key}"`);
    if (at === -1) continue;

    let i = at + key.length + 2;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== ':') continue;
    i++;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== '"') continue;

    let end = -1;
    let escaped = false;
    for (let k = i + 1; k < raw.length; k++) {
      const c = raw[k];
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') { end = k; break; }
    }

    // No closing quote means the stream stopped mid-value; close it ourselves,
    // dropping a dangling backslash that would otherwise escape the quote we add.
    const literal = end === -1
      ? `${raw.slice(i).replace(/\\+$/, (m) => (m.length % 2 ? m.slice(0, -1) : m))}"`
      : raw.slice(i, end + 1);

    try {
      const value = JSON.parse(repairJson(literal));
      if (typeof value === 'string' && value) return value;
    } catch { /* try the next key */ }
  }
  return '';
}

/**
 * The text inside a frame that would not parse, or '' if there is none to find.
 *
 * Recovering the answer and losing the wrapper beats showing the wrapper: nobody
 * reading a chat reply wants `{"completionText":"..."}` in it, and the frame shape
 * is a fact about the transport, not something the model said.
 */
function salvageText(raw, override) {
  const padded = stripPadding(raw);
  const parsed = parseLenient(padded);
  if (parsed) {
    const text = textFrom(parsed.value, override);
    if (text) return text;
  }

  const keys = override
    ? [override.split('.').pop()]
    : [...new Set(TEXT_PATHS.map((p) => p.split('.').pop()))].filter((k) => !/^\d+$/.test(k));
  return textByKey(padded, keys);
}

/** Whether `raw` is a JSON value at all - anything else is legitimately plain text. */
function looksLikeJson(raw) {
  const c = stripPadding(raw)[0];
  return c === '{' || c === '[';
}

const FINISH_KEYS = ['stopReason', 'stop_reason', 'finishReason', 'finish_reason'];
/** Frame-level markers that mean "the answer was cut short, ask for the rest". */
const TRUNCATED = /^(charlimit|length|max_tokens|max_output_tokens|truncated)$/i;

/**
 * Where a frame names the model that actually served it. Nothing validates the
 * model name on the way out - the body carries whatever was configured - so an
 * unknown name reaches a backend that is free to quietly serve its default
 * instead. That substitution is invisible in the answer, which is exactly why it
 * is worth reading back. `ellm.servedModelPath` overrides the guessing.
 */
const MODEL_PATHS = [
  'model', 'modelId', 'model_id', 'modelAlias', 'modelName', 'model_name',
  'engine', 'deployment', 'metadata.model', 'payload.model', 'data.model',
];

function dig(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * An API-gateway transport envelope - the `{"statusCode":200,"headers":{...}}` this
 * backend puts in front of the real frames. It describes the HTTP response, so no
 * field in it is ever part of the answer.
 */
function isTransportEnvelope(frame) {
  return Boolean(frame)
    && typeof frame === 'object'
    && ('statusCode' in frame || 'status_code' in frame)
    && 'headers' in frame;
}

/** The text carried by one parsed frame, or '' if it carries none. */
function textFrom(frame, override) {
  if (typeof frame === 'string') return frame;
  if (!frame || typeof frame !== 'object') return '';
  if (!override && isTransportEnvelope(frame)) return '';

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

/** The model a parsed frame says served it, or '' if it names none. */
function modelFrom(frame, override) {
  if (!frame || typeof frame !== 'object') return '';
  // The gateway prelude describes the HTTP response, so nothing in it names the
  // model that answered - reading one out of it would report a false match.
  if (!override && isTransportEnvelope(frame)) return '';

  if (override) {
    const found = dig(frame, override);
    return typeof found === 'string' ? found.trim() : '';
  }
  for (const path of MODEL_PATHS) {
    const found = dig(frame, path);
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return '';
}

/**
 * Whether a served name is the model that was asked for. Backends routinely
 * answer with a longer, more specific name than the one requested - a pinned
 * snapshot, a deployment id, a different case - so "asked for X, got X-2026-01"
 * is a match. Only a name with no relation to the request is a real mismatch.
 */
function sameModel(requested, served) {
  const a = normalizeModel(requested);
  const b = normalizeModel(served);
  if (!a || !b) return true; // nothing to compare is not a mismatch
  return a.includes(b) || b.includes(a);
}

/** Model names for comparison: case, spaces, dots and dashes are all noise. */
function normalizeModel(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Key names that plausibly select a model, whatever a given backend calls it. */
const MODEL_KEY_HINT = /model|engine|deployment|variant|\bllm\b/i;

/**
 * Extra request fields that may *also* be choosing a model.
 *
 * The extra-fields block is pasted verbatim out of one captured real request, so
 * whatever key that request used to pick a model is sitting in it, frozen at the
 * value that request happened to use. It is merged into every body afterwards.
 * If the backend reads *that* key rather than the configured one, the picker
 * changes nothing and every answer comes from one fixed model - which looks
 * exactly like "I chose a model and got a different one".
 *
 * A value equal to one of the configured model names is the strong signal; a
 * model-shaped key name is the weak one. Both are reported, neither is guessed at
 * and silently rewritten: only the person who captured the request knows which
 * key the backend really reads.
 */
function modelFieldConflicts({ extra, modelField, models = [] } = {}) {
  const known = new Set(models.map(normalizeModel).filter(Boolean));
  const found = [];

  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [key, inner] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (inner && typeof inner === 'object') {
        walk(inner, at, depth + 1);
        continue;
      }
      if (at === modelField) {
        found.push({ path: at, reason: 'overridden' });
        continue;
      }
      if (typeof inner !== 'string' || !inner.trim()) continue;
      if (known.has(normalizeModel(inner))) found.push({ path: at, value: inner, reason: 'names-a-model' });
      else if (MODEL_KEY_HINT.test(key)) found.push({ path: at, value: inner, reason: 'model-shaped-key' });
    }
  };

  walk(extra, '', 0);
  return found;
}

/** Header and body keys whose values are credentials rather than configuration. */
/**
 * Matched against the key with its separators removed, because real header names are
 * hyphenated: `X-Api-Key` does not contain "apikey" or "api_key" until the hyphens go,
 * so it printed its value in full. This view exists to be pasted to someone else for
 * diagnosis, and the auth header name is configurable, so a credential is only safe
 * here if it is masked no matter what the field is called.
 *
 * "signature" but not "sig": with separators stripped a bare "sig" matches "design"
 * and "assign", and over-masking buries the configuration this view exists to show.
 */
const SECRET_KEY_HINT = new RegExp([
  'token', 'secret', 'password', 'passwd', 'pwd', 'auth', 'cookie',
  'apikey', 'accesskey', 'privatekey', 'credential', 'session',
  'jwt', 'signature', 'csrf', 'xsrf', 'bearer', 'oauth', 'saml', 'assertion', 'refresh',
].join('|'), 'i');

/** A key with separators and casing removed, so `X-Api-Key` reads as `xapikey`. */
const normaliseKey = (key) => String(key ?? '').replace(/[^a-z0-9]/gi, '');

/**
 * Token *limits*, which are configuration and not credentials. `max_tokens`
 * contains "token" and was being hidden as if it were one - which buries a
 * number worth seeing and makes the output look like it is hiding more than it
 * is. Credentials are also always strings, so a number is never masked either.
 */
const TOKEN_LIMIT_KEY = /^(max|min|num|n|total|input|output|prompt|completion)[_-]?tokens?$/i;

/**
 * The request as text, for reading beside the web app's payload in DevTools.
 *
 * Two things are held back even though this is the machine that owns them: the
 * credentials, because a log gets pasted into a chat window the moment something
 * is confusing, and the prompt, because it is the source file being worked on.
 * Everything that decides *which model answers* is shown in full - that is the
 * whole point of looking.
 */
function describeRequest({ url, body, headers, promptField }, { values = true } = {}) {
  const mask = (key, value) => {
    if (key === promptField) {
      const len = String(value ?? '').length;
      return `<prompt, ${len} chars, hidden>`;
    }
    if (typeof value !== 'string') return value; // a credential is never a number
    // An inlined screenshot is ~200k characters of base64. Printed in full it
    // buries every other field and makes this view useless for the one job it
    // has, so it is summarised by shape rather than by field name.
    if (value.startsWith('data:')) {
      const kind = value.slice(5).split(/[;,]/)[0] || 'data';
      return `<${kind}, ${value.length} chars, hidden>`;
    }
    if (TOKEN_LIMIT_KEY.test(key)) return value;
    if (SECRET_KEY_HINT.test(normaliseKey(key))) return `<${value.length} chars, hidden>`;
    return value;
  };

  const walk = (value, key) => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    const masked = mask(key, value);
    // Key-name mode: enough to find the field that selects the model, without
    // putting the tenant, the user block or anything else on screen.
    if (!values && masked === value) return typeof value;
    return masked;
  };

  const shownHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [k, mask(k, v)]),
  );

  return [
    `POST ${url}`,
    'headers:',
    JSON.stringify(shownHeaders, null, 2),
    'body:',
    JSON.stringify(walk(body, ''), null, 2),
  ].join('\n');
}

/** One line per conflict, phrased for someone staring at a DevTools capture. */
function describeConflict(conflict, modelField) {
  if (conflict.reason === 'overridden') {
    return `"${conflict.path}" in the extra fields is ignored - the picked model is sent in "${modelField}".`;
  }
  if (conflict.reason === 'names-a-model') {
    return `"${conflict.path}" is fixed at "${conflict.value}", which is one of your model names. `
      + `If the backend reads that field instead of "${modelField}", every reply comes from `
      + `"${conflict.value}" no matter what the picker says - set "Model field" to "${conflict.path}" `
      + 'and delete it from the extra fields.';
  }
  return `"${conflict.path}" is fixed at "${conflict.value}" and is named like a model selector. `
    + `If that is the field the backend reads, set "Model field" to "${conflict.path}" and remove it `
    + 'from the extra fields, or the picker has no effect.';
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
    url, token, authHeader, authPrefix, cookie, chatPath, promptField, modelField,
    model, models, identity, params, textPath, servedModelPath,
    contextChars, maxResponseChars, imageField,
  } = {}) {
    // Which body key carries the prompt is the backend's business, not this file's.
    this.promptField = promptField || DEFAULT_PROMPT_FIELD;
    // Nor which key selects the model. `model` is only the common spelling of it,
    // and a backend that spells it differently ignores the picker entirely while
    // still answering perfectly - see modelFieldConflicts above.
    this.modelField = modelField || DEFAULT_MODEL_FIELD;
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
    this.servedModelPath = servedModelPath || '';
    // Empty means this backend takes text only. Attached images are then named in
    // the prompt rather than sent, because a model that is handed a question about
    // a picture it never received answers it anyway - see toPrompt.
    this.imageField = imageField || '';
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
    if (turns.length === 1) return this.utteranceOf(turns[0]);
    return turns
      .map((t) => `${label[t.speaker] ?? 'User'}: ${this.utteranceOf(t)}`)
      .join('\n\n');
  }

  /**
   * One turn's text, with any image it carried accounted for.
   *
   * An image that cannot be sent must still be mentioned. Dropping it silently
   * leaves the model reading "what does this say?" with nothing attached, and a
   * model in that position does not say it saw no image - it invents a plausible
   * one. Naming the attachment is what turns a confident fabrication into "you
   * sent me an image I cannot read".
   */
  utteranceOf(turn) {
    const text = turn?.utterance ?? '';
    const images = turn?.images ?? [];
    if (!images.length || this.imageField) return text;

    const note = images.map((img) => `[attached image: ${img.mimeType || 'image'}, `
      + `${Math.max(1, Math.round((img.data?.length ?? 0) * 0.75 / 1024))} KB. This endpoint `
      + 'cannot receive images, so it was NOT sent - you cannot see it. Say so; do not guess '
      + 'at its contents.]').join('\n');
    return text ? `${text}\n${note}` : note;
  }

  /** Every image across the conversation, in order, as the backend wants them. */
  imagesIn(turns) {
    return (turns ?? []).flatMap((t) => t.images ?? [])
      .map((img) => `data:${img.mimeType || 'image/png'};base64,${img.data}`);
  }

  body({ modelAlias, turns }) {
    const images = this.imageField ? this.imagesIn(turns) : [];
    return {
      ...this.identity, // whatever extra fields the backend expects, verbatim
      ...this.params, // tuning knobs, exactly as configured
      // Last, so the picked model always wins over a stale copy of itself in the
      // extra fields. It cannot win over a *differently named* field, which is
      // what modelFieldConflicts is for.
      [this.modelField]: modelAlias || this.model,
      [this.promptField]: this.toPrompt(turns),
      ...(images.length ? { [this.imageField]: images } : {}),
      stream: true,
    };
  }

  /** What this request will send about the model, without sending it. */
  requestShape({ modelAlias, turns = [] } = {}) {
    const extra = { ...this.identity, ...this.params };
    return {
      modelField: this.modelField,
      model: modelAlias || this.model,
      url: this.endpoint,
      // The payload itself, so it can be read the way the web app's is read in
      // DevTools. Masking happens at the point of display, not here - callers
      // that need the real body (the request) must not get a redacted one.
      body: this.body({ modelAlias, turns }),
      headers: this.headers(),
      conflicts: modelFieldConflicts({
        extra,
        modelField: this.modelField,
        models: this.models,
      }),
    };
  }

  /** Yields { type:'text', text } then a final { type:'finish', reason }. */
  async *converse({
    modelAlias, turns, signal, onRawFrame, onServedModel, onFrameProblem, onRequest,
  }) {
    const url = this.endpoint;
    if (onRequest) onRequest(this.requestShape({ modelAlias, turns }));
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
    let reportedModel = false;
    const requested = modelAlias || this.model;

    const noteModel = (frame) => {
      // Read the served model off the first frame that names one. Reported even
      // when it matches, so the output channel always answers "which model was
      // that?" without a second run.
      if (reportedModel || !onServedModel) return;
      const served = modelFrom(frame, this.servedModelPath);
      if (!served) return;
      reportedModel = true;
      onServedModel({
        requested, served, matches: sameModel(requested, served), confirmed: true,
      });
    };

    const noteRaw = (raw) => {
      // The first frame is recorded verbatim: when the shape is not what this file
      // expects, that one line is the whole diagnosis.
      if (reportedRaw) return;
      reportedRaw = true;
      firstRaw = raw.slice(0, 400);
      if (onRawFrame) onRawFrame(firstRaw);
    };

    const noteProblem = (msg) => {
      if (onFrameProblem) onFrameProblem(msg);
    };

    /**
     * A frame this reader could not parse. Whatever went wrong upstream, the one
     * thing that must not happen is the envelope reaching the chat as if the model
     * had written it: a reply that opens `{"completionText":"I'll impl"}ement...`
     * is worse than a reply missing a fragment, and it poisons the history the
     * next turn is built from. Recover the text, report the frame to the log.
     */
    const asBrokenFrame = (raw) => {
      noteRaw(raw);
      const text = salvageText(raw, this.textPath);
      const shown = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
      if (!text) {
        noteProblem(`dropped an unreadable frame (no text in it): ${shown}`);
        return [];
      }
      noteProblem(`recovered ${text.length} char(s) from an unreadable frame: ${shown}`);
      sawText = true;
      return [{ type: 'text', text }];
    };

    const asText = (text) => {
      // A line that is really a frame gets treated as one however it got here.
      if (looksLikeJson(text)) return asBrokenFrame(text);
      noteRaw(text);
      sawText = true;
      return [{ type: 'text', text }];
    };

    const handleFrame = (raw) => {
      noteRaw(raw);
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return asBrokenFrame(raw); // balanced braces, but not valid JSON
      }

      noteModel(frame);
      finish = finishFrom(frame) ?? finish;
      const text = textFrom(frame, this.textPath);
      if (!text) return []; // an envelope or a keep-alive, carrying nothing to show
      sawText = true;
      return [{ type: 'text', text }];
    };

    /**
     * Consume whatever is complete in the buffer. `final` means the stream has
     * ended, so a partial value is all we are ever going to get and is better
     * shown than dropped.
     */
    const drain = (final) => {
      const events = [];

      for (;;) {
        buffer = stripPadding(buffer);
        if (!buffer) break;

        // SSE bookkeeping lines carry no payload.
        const control = /^(?::|event:|id:|retry:)[^\n]*(\n|$)/.exec(buffer);
        if (control) {
          if (!control[1] && !final) break; // still arriving
          buffer = buffer.slice(control[0].length);
          continue;
        }

        if (buffer.startsWith('data:')) {
          buffer = buffer.slice(5).replace(/^[ \t]*/, '');
          continue;
        }

        // Checked before the JSON branch: "[DONE]" would otherwise look like an array.
        const end = /^(\[DONE\]|EOM)/.exec(buffer);
        if (end) {
          finish = finish ?? 'stop';
          buffer = buffer.slice(end[0].length);
          continue;
        }

        if (buffer[0] === '{' || buffer[0] === '[') {
          const taken = takeJson(buffer);
          if (taken?.incomplete) {
            if (!final) break; // wait for the rest of the object
            // The stream stopped mid-object, which is what a per-response cap does.
            events.push(...asBrokenFrame(buffer));
            buffer = '';
            break;
          }
          buffer = taken.rest;
          events.push(...handleFrame(taken.raw));
          continue;
        }

        // Plain text, which is a legitimate stream shape on its own.
        const nl = buffer.indexOf('\n');
        if (nl === -1) {
          if (!final) break;
          events.push(...asText(buffer));
          buffer = '';
          break;
        }
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) events.push(...asText(line));
      }

      return events;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const ev of drain(false)) yield ev;
    }
    for (const ev of drain(true)) yield ev;

    // Say so when no frame named a model. Staying quiet here reads exactly like a
    // clean match, so the one case where the picked model is unverifiable - the
    // case where a silent substitution would hide - is the case that looked fine.
    if (!reportedModel && onServedModel) {
      onServedModel({ requested, served: '', matches: null, confirmed: false });
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

module.exports = {
  CorpClient, CorpAuthError, textFrom, finishFrom, modelFrom, sameModel,
  salvageText, stripPadding, isTransportEnvelope,
  modelFieldConflicts, describeConflict, normalizeModel, describeRequest,
};
