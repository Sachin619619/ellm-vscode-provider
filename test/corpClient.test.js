/**
 * What the client sends, what it makes of what comes back, and what it says when
 * the endpoint refuses it. Getting the last one wrong costs an afternoon: a 401
 * because the URL is not an API reads exactly like a 401 because the token
 * expired, and the message decides which one you go and check.
 *
 *   node --test test/*.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { CorpClient, CorpAuthError, textFrom, finishFrom } = require('../src/corpClient');

/** Minimal stand-in for a fetch Response, streaming `frames` as SSE lines. */
function response({ status = 200, body = '', contentType = 'text/event-stream', frames }) {
  const payload = frames ? frames.map((f) => `data: ${f}\n`).join('') : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => payload,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: new TextEncoder().encode(payload) };
          },
        };
      },
    },
  };
}

/** Runs `fn` with fetch stubbed, returning the error (if any) and what was sent. */
async function withFetch(res, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return typeof res === 'function' ? res(url, init) : res;
  };
  try {
    return { value: await fn().then((v) => v, (e) => { throw e; }), seen };
  } finally {
    globalThis.fetch = original;
  }
}

const client = (over = {}) => new CorpClient({
  url: 'https://llm.example.com', token: 'tok', chatPath: '/api/chat', ...over,
});

/** Drains converse() into { text, finish }. */
async function converse(c, over = {}) {
  let text = '';
  let finish;
  for await (const ev of c.converse({ turns: [{ speaker: 'human', utterance: 'Hi' }], ...over })) {
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'finish') finish = ev.reason;
  }
  return { text, finish };
}

// --- what goes out ----------------------------------------------------------

test('the configured path is appended to the configured origin', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client()));
  assert.strictEqual(seen[0].url, 'https://llm.example.com/api/chat');
});

test('a path without a leading slash still forms one URL', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ url: 'https://llm.example.com/', chatPath: 'api/chat' })));
  assert.strictEqual(seen[0].url, 'https://llm.example.com/api/chat');
});

test('the token goes in the configured header with the configured prefix', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ authHeader: 'Authorization', authPrefix: 'Bearer ' })));
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer tok');
});

test('a raw token is sent unprefixed when no prefix is configured', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ authHeader: 'Authorization' })));
  assert.strictEqual(seen[0].init.headers.Authorization, 'tok');
});

test('a cookie is sent only when one is configured', async () => {
  const without = await withFetch(response({ frames: ['{"text":"hi"}'] }), () => converse(client()));
  assert.strictEqual(without.seen[0].init.headers.cookie, undefined);

  const with_ = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ cookie: 'a=1; b=2' })));
  assert.strictEqual(with_.seen[0].init.headers.cookie, 'a=1; b=2');
});

test('identity and params are merged into the body, never invented', async () => {
  const identity = { Tenant: 'example.net', userInfo: { mail: 'x@example.net' } };
  const params = { temperature: 0.3, max_tokens: 4096 };
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ identity, params, model: 'some-model' })));

  const body = seen[0].body;
  assert.strictEqual(body.Tenant, 'example.net');
  assert.deepStrictEqual(body.userInfo, { mail: 'x@example.net' });
  assert.strictEqual(body.temperature, 0.3);
  assert.strictEqual(body.model, 'some-model');
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.prompt, 'Hi');
});

test('with nothing configured the body carries no company fields at all', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client()));
  // Only the three keys the protocol itself defines - no defaults smuggled in.
  assert.deepStrictEqual(Object.keys(seen[0].body).sort(), ['model', 'prompt', 'stream']);
});

test('multi-turn history is flattened into one labelled prompt', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }), () => converse(client(), {
    turns: [
      { speaker: 'system', utterance: 'Be brief.' },
      { speaker: 'human', utterance: 'Hello' },
      { speaker: 'assistant', utterance: 'Hi' },
      { speaker: 'human', utterance: 'More' },
    ],
  }));
  assert.strictEqual(
    seen[0].body.prompt,
    'System: Be brief.\n\nUser: Hello\n\nAssistant: Hi\n\nUser: More',
  );
});

// --- what comes back --------------------------------------------------------

test('text is found in whichever field the backend uses', async () => {
  const shapes = [
    '{"payload":{"deltaText":"A"}}', '{"delta":{"text":"A"}}', '{"text":"A"}',
    '{"content":"A"}', '{"choices":[{"delta":{"content":"A"}}]}',
  ];
  for (const frame of shapes) {
    const { value } = await withFetch(response({ frames: [frame] }), () => converse(client()));
    assert.strictEqual(value.text, 'A', frame);
  }
});

test('an explicit textPath wins over auto-detection', async () => {
  const frame = '{"text":"wrong","mine":{"deep":"right"}}';
  const { value } = await withFetch(response({ frames: [frame] }),
    () => converse(client({ textPath: 'mine.deep' })));
  assert.strictEqual(value.text, 'right');
});

test('chunks are concatenated in order', async () => {
  const { value } = await withFetch(
    response({ frames: ['{"text":"Hel"}', '{"text":"lo "}', '{"text":"there"}'] }),
    () => converse(client()),
  );
  assert.strictEqual(value.text, 'Hello there');
});

test('a truncation marker becomes finish reason "length" so continuation kicks in', async () => {
  for (const marker of ['charLimit', 'length', 'max_tokens']) {
    const { value } = await withFetch(
      response({ frames: ['{"text":"cut"}', `{"stopReason":"${marker}"}`] }),
      () => converse(client()),
    );
    assert.strictEqual(value.finish, 'length', marker);
  }
});

test('a normal completion reports "stop"', async () => {
  const { value } = await withFetch(
    response({ frames: ['{"text":"done"}', '{"finish_reason":"stop"}'] }),
    () => converse(client()),
  );
  assert.strictEqual(value.finish, 'stop');
});

test('a plain-text stream is passed through rather than dropped', async () => {
  const { value } = await withFetch(response({ body: 'just text\nmore text\n' }),
    () => converse(client()));
  assert.strictEqual(value.text, 'just textmore text');
});

test('[DONE] and EOM end the stream without becoming visible text', async () => {
  const { value } = await withFetch(response({ frames: ['{"text":"hi"}', '[DONE]'] }),
    () => converse(client()));
  assert.strictEqual(value.text, 'hi');
  assert.strictEqual(value.finish, 'stop');
});

test('SSE comments and event lines are ignored', async () => {
  const { value } = await withFetch(
    response({ body: ': keep-alive\nevent: message\ndata: {"text":"hi"}\n' }),
    () => converse(client()),
  );
  assert.strictEqual(value.text, 'hi');
});

test('a stream with no recognisable text says so instead of returning silence', async () => {
  await assert.rejects(
    () => withFetch(response({ frames: ['{"unexpected":{"nested":1}}'] }), () => converse(client())),
    /no text could be found.*ellm\.textPath/s,
  );
});

test('the first raw frame is reported once, for diagnosis', async () => {
  const frames = [];
  await withFetch(response({ frames: ['{"text":"a"}', '{"text":"b"}'] }),
    () => converse(client(), { onRawFrame: (raw) => frames.push(raw) }));
  assert.deepStrictEqual(frames, ['{"text":"a"}']);
});

// --- when it goes wrong -----------------------------------------------------

test('a 404 blames the path, not the token', async () => {
  await assert.rejects(
    () => withFetch(response({ status: 404, body: 'Not Found' }), () => converse(client())),
    (err) => !(err instanceof CorpAuthError) && /No such endpoint.*chat path/s.test(err.message),
  );
});

test('a 401 names the header it used and points at expiry', async () => {
  await assert.rejects(
    () => withFetch(response({ status: 401, body: '{"error":"expired"}' }),
      () => converse(client({ authHeader: 'Authorization' }))),
    (err) => err instanceof CorpAuthError
      && /Authorization/.test(err.message)
      && /expired/.test(err.message)
      && /short-lived/.test(err.message),
  );
});

test('a 401 with no cookie configured says the gateway may want one', async () => {
  await assert.rejects(
    () => withFetch(response({ status: 401, body: 'no' }), () => converse(client())),
    /no Cookie header/,
  );
});

test('an HTML 401 says the sign-in expired rather than blaming the token', async () => {
  await assert.rejects(
    () => withFetch(
      response({ status: 403, body: '<!doctype html><html>Sign in</html>', contentType: 'text/html' }),
      () => converse(client()),
    ),
    (err) => err instanceof CorpAuthError && /web page/i.test(err.message),
  );
});

test('a 500 is a server error, not an auth error', async () => {
  await assert.rejects(
    () => withFetch(response({ status: 500, body: 'boom' }), () => converse(client())),
    (err) => !(err instanceof CorpAuthError) && /500/.test(err.message),
  );
});

// --- model list -------------------------------------------------------------

test('models come from configuration, and listModels contacts nothing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('listModels must not make a request'); };
  try {
    const info = await client({ models: ['a', 'b'] }).listModels();
    assert.deepStrictEqual(info.models.map((m) => m.alias), ['a', 'b']);
  } finally {
    globalThis.fetch = original;
  }
});

// --- helpers ----------------------------------------------------------------

test('textFrom ignores non-string fields', () => {
  assert.strictEqual(textFrom({ text: 42 }), '');
  assert.strictEqual(textFrom({ text: 'ok' }), 'ok');
  assert.strictEqual(textFrom('bare string'), 'bare string');
});

test('finishFrom returns undefined while the answer is still arriving', () => {
  assert.strictEqual(finishFrom({ text: 'partial' }), undefined);
  assert.strictEqual(finishFrom({ done: true }), 'stop');
});

test('the prompt goes in whichever body field the backend names', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ promptField: 'question' })));
  assert.strictEqual(seen[0].body.question, 'Hi');
  assert.strictEqual(seen[0].body.prompt, undefined);
});
