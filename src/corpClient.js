/**
 * Speaks the enterprise LLM's own protocol. Nothing here is OpenAI-shaped:
 *
 *   POST {url}/corp/v2/converse
 *   header  X-Corp-Auth: <token>
 *   body    { modelAlias, turns:[{speaker,utterance}], streaming:true }
 *   SSE     data: {"event":"chunk","payload":{"deltaText":"..."}}
 *           data: {"event":"complete","stopReason":"finished"|"charLimit"}
 *           data: EOM
 *
 * This is the file to rewrite when pointing the extension at the real eLLM -
 * the provider above it only consumes {type:'text'|'finish'} events.
 */

class CorpAuthError extends Error {}

class CorpClient {
  constructor({ url, token }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token || '';
  }

  get configured() {
    return Boolean(this.url && this.token);
  }

  async listModels() {
    const res = await fetch(`${this.url}/corp/v2/models`, { headers: { 'X-Corp-Auth': this.token } });
    if (res.status === 401 || res.status === 403) throw new CorpAuthError('Token rejected by the enterprise LLM');
    if (!res.ok) throw new Error(`Enterprise LLM returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  /** Yields { type:'text', text } then a final { type:'finish', reason }. */
  async *converse({ modelAlias, turns, signal }) {
    const res = await fetch(`${this.url}/corp/v2/converse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Corp-Auth': this.token },
      body: JSON.stringify({ modelAlias, turns, streaming: true }),
      signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new CorpAuthError('Token rejected - it has probably expired. Run "Enterprise LLM: Configure Connection".');
    }
    if (!res.ok) throw new Error(`Enterprise LLM returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

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
