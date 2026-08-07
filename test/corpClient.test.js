/**
 * What the client says when the endpoint rejects it. Getting this wrong costs an
 * afternoon: a 401 because the URL is not an API at all reads exactly like a 401
 * because the token expired, and the message decides which one you go and check.
 *
 *   node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { CorpClient, CorpAuthError } = require('../src/corpClient');

/** Minimal stand-in for a fetch Response. */
function response({ status, body = '', contentType = 'application/json' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  };
}

/** Runs `fn` with fetch stubbed, returning whatever the stub was called with. */
async function withFetch(res, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return typeof res === 'function' ? res(url, init) : res;
  };
  try {
    return { error: await fn().then(() => null, (e) => e), seen };
  } finally {
    globalThis.fetch = original;
  }
}

const client = (over = {}) => new CorpClient({ url: 'https://llm.corp', token: 'tok', ...over });

test('a 404 blames the endpoint path, not the token', async () => {
  const { error } = await withFetch(response({ status: 404, body: 'Not Found' }),
    () => client().listModels());
  assert.ok(!(error instanceof CorpAuthError), 'a missing route is not an auth problem');
  assert.match(error.message, /No such endpoint/);
  assert.match(error.message, /corpClient\.js/, 'must point at the file to rewrite');
});

test('a 401 names the auth header it actually sent', async () => {
  const { error } = await withFetch(response({ status: 401, body: '{"error":"invalid token"}' }),
    () => client().listModels());
  assert.ok(error instanceof CorpAuthError);
  assert.match(error.message, /X-Corp-Auth/);
  assert.match(error.message, /invalid token/, 'the server\'s own words are the useful part');
  assert.match(error.message, /Bearer/, 'suggests the usual alternative');
});

test('a 401 naming a custom header reports that header', async () => {
  const { error } = await withFetch(response({ status: 401, body: 'nope' }),
    () => client({ authHeader: 'X-Company-Key' }).listModels());
  assert.match(error.message, /X-Company-Key/);
  assert.doesNotMatch(error.message, /X-Corp-Auth/);
});

test('an HTML 401 says the URL is a web page, not an API', async () => {
  const { error } = await withFetch(
    response({ status: 403, body: '<!doctype html><html><body>Sign in</body></html>', contentType: 'text/html; charset=utf-8' }),
    () => client().listModels(),
  );
  assert.ok(error instanceof CorpAuthError);
  assert.match(error.message, /web page/i);
  assert.match(error.message, /DevTools/, 'tells you how to find the real endpoint');
});

test('a 500 is a server error, not an auth error', async () => {
  const { error } = await withFetch(response({ status: 500, body: 'boom' }),
    () => client().listModels());
  assert.ok(!(error instanceof CorpAuthError));
  assert.match(error.message, /500/);
});

test('the token is sent in the configured header, with the configured prefix', async () => {
  const { seen } = await withFetch(response({ status: 200, body: '{"models":[]}' }),
    () => client({ authHeader: 'Authorization', authPrefix: 'Bearer ' }).listModels());
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer tok');
});

test('with no prefix configured the raw token is sent', async () => {
  const { seen } = await withFetch(response({ status: 200, body: '{"models":[]}' }),
    () => client().listModels());
  assert.strictEqual(seen[0].init.headers['X-Corp-Auth'], 'tok');
});

test('a trailing slash on the URL does not double up in the path', async () => {
  const { seen } = await withFetch(response({ status: 200, body: '{"models":[]}' }),
    () => client({ url: 'https://llm.corp///' }).listModels());
  assert.strictEqual(seen[0].url, 'https://llm.corp/corp/v2/models');
});

test('converse authenticates the same way as listModels', async () => {
  const { seen } = await withFetch(
    () => response({ status: 401, body: 'no' }),
    async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of client({ authHeader: 'X-Key' }).converse({ modelAlias: 'm', turns: [] })) { /* drains */ }
    },
  );
  assert.strictEqual(seen[0].init.headers['X-Key'], 'tok');
});
