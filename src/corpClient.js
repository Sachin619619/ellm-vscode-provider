/**
 * Speaks the enterprise LLM's own protocol. Nothing here is OpenAI-shaped:
 *
 *   POST {url}/corp/v2/converse
 *   header  X-Corp-Auth: <token>          (name/prefix configurable)
 *   body    { modelAlias, turns:[{speaker,utterance}], streaming:true }
 *   SSE     data: {"event":"chunk","payload":{"deltaText":"..."}}
 *           data: {"event":"complete","stopReason":"finished"|"charLimit"}
 *           data: EOM
 *
 * This is the file to rewrite when pointing the extension at the real eLLM -
 * the provider above it only consumes {type:'text'|'finish'} events. The auth
 * header is settable without touching code, since that alone is often the whole
 * difference; the paths and body shape are not, and are the usual reason a real
 * endpoint answers 404 or 401 here.
 */

class CorpAuthError extends Error {}

const DEFAULT_AUTH_HEADER = 'X-Corp-Auth';

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
    return new Error(
      `No such endpoint (${where}). This extension still speaks the bundled sample protocol `
      + '(/corp/v2/…). Point it at your real API by rewriting src/corpClient.js.',
    );
  }

  if (res.status === 401 || res.status === 403) {
    if (isHtml) {
      return new CorpAuthError(
        `The endpoint answered with a web page rather than an API response (${where}). That URL is `
        + 'probably the chat site itself, not its API — and a browser session cookie will not work '
        + 'as a token. Capture the real API request in DevTools → Network.',
      );
    }
    return new CorpAuthError(
      `Token rejected (${where})${snippet ? `. Server said: ${snippet}` : ''}. If the token is `
      + `definitely current, the auth header is the next suspect — this sent "${client.authHeader}". `
      + 'Most APIs want "Authorization" with a "Bearer " prefix (settings: ellm.authHeader, ellm.authPrefix).',
    );
  }

  return new Error(`Enterprise LLM returned ${where}${snippet ? `: ${snippet}` : ''}`);
}

class CorpClient {
  constructor({ url, token, authHeader, authPrefix }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token || '';
    this.authHeader = authHeader || DEFAULT_AUTH_HEADER;
    this.authPrefix = authPrefix || '';
  }

  get configured() {
    return Boolean(this.url && this.token);
  }

  /** The auth header, whatever this deployment happens to call it. */
  authHeaders() {
    return { [this.authHeader]: `${this.authPrefix}${this.token}` };
  }

  async listModels() {
    const url = `${this.url}/corp/v2/models`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw await failureFor(res, url, this);
    return res.json();
  }

  /** Yields { type:'text', text } then a final { type:'finish', reason }. */
  async *converse({ modelAlias, turns, signal }) {
    const url = `${this.url}/corp/v2/converse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ modelAlias, turns, streaming: true }),
      signal,
    });

    if (!res.ok) throw await failureFor(res, url, this);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finish;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === 'EOM') continue;

        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }

        if (frame.event === 'chunk' && frame.payload?.deltaText) {
          yield { type: 'text', text: frame.payload.deltaText };
        } else if (frame.event === 'complete') {
          // 'charLimit' is the upstream saying it truncated - the continuation
          // layer treats that exactly like OpenAI's finish_reason 'length'.
          finish = frame.stopReason === 'charLimit' ? 'length' : 'stop';
        } else if (frame.event === 'error') {
          throw new Error(`Enterprise LLM error ${frame.code}: ${frame.message ?? ''}`);
        }
      }
    }

    yield { type: 'finish', reason: finish };
  }
}

module.exports = { CorpClient, CorpAuthError };
