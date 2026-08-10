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
const {
  CorpClient, CorpAuthError, textFrom, finishFrom, modelFrom, sameModel,
  salvageText, stripPadding, modelFieldConflicts, describeRequest,
} = require('../src/corpClient');
const { repairJson, parseLenient } = require('../src/jsonRepair');

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

// --- which field carries the model ------------------------------------------
//
// A backend that reads a different key answers perfectly well from its default,
// so nothing about the reply reveals that the picker was ignored. These pin the
// request side, which is the only side that can be checked.

test('the picked model goes in whichever body field the backend names', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ modelField: 'AiModelName' }), { modelAlias: 'opus-4-8' }));
  assert.strictEqual(seen[0].body.AiModelName, 'opus-4-8');
  assert.strictEqual(seen[0].body.model, undefined);
});

test('a stale copy of the model in the extra fields never beats the picker', async () => {
  const { seen } = await withFetch(response({ frames: ['{"text":"hi"}'] }),
    () => converse(client({ identity: { model: 'captured-default' } }), { modelAlias: 'opus-4-8' }));
  assert.strictEqual(seen[0].body.model, 'opus-4-8');
});

test('an extra field fixed at one of the model names is reported as a conflict', () => {
  // The shape a DevTools capture leaves behind: the real selector, frozen at
  // whatever that one request used, under a name this code cannot know.
  const conflicts = modelFieldConflicts({
    extra: { Flavour: 'some-other-model', Tenant: 'example.net' },
    modelField: 'model',
    models: ['opus 4.8', 'some-other-model'],
  });
  assert.deepStrictEqual(conflicts,
    [{ path: 'Flavour', value: 'some-other-model', reason: 'names-a-model' }]);
});

test('a model-shaped extra field is reported even when its value is unfamiliar', () => {
  const conflicts = modelFieldConflicts({
    extra: { deployment: 'prod-eastus-2', Tenant: 'example.net' },
    modelField: 'model',
    models: ['opus 4.8'],
  });
  assert.deepStrictEqual(conflicts,
    [{ path: 'deployment', value: 'prod-eastus-2', reason: 'model-shaped-key' }]);
});

test('a conflict nested inside the captured block is still found', () => {
  const conflicts = modelFieldConflicts({
    extra: { options: { llm: 'opus 4.8' } },
    modelField: 'model',
    models: ['opus 4.8'],
  });
  assert.deepStrictEqual(conflicts, [{ path: 'options.llm', value: 'opus 4.8', reason: 'names-a-model' }]);
});

test('the configured model field itself is reported as merely overridden', () => {
  const conflicts = modelFieldConflicts({
    extra: { model: 'captured-default' }, modelField: 'model', models: ['opus 4.8'],
  });
  assert.deepStrictEqual(conflicts, [{ path: 'model', reason: 'overridden' }]);
});

test('ordinary identity fields raise no conflict', () => {
  assert.deepStrictEqual(modelFieldConflicts({
    extra: { Tenant: 'example.net', userInfo: { mail: 'x@example.net' } },
    modelField: 'model',
    models: ['opus 4.8'],
  }), []);
});

test('requestShape states the field and value without sending anything', () => {
  const shape = client({ modelField: 'engine', identity: { engineName: 'opus 4.8' }, models: ['opus 4.8'] })
    .requestShape({ modelAlias: 'opus 4.8' });
  assert.strictEqual(shape.modelField, 'engine');
  assert.strictEqual(shape.model, 'opus 4.8');
  assert.strictEqual(shape.conflicts.length, 1);
});

test('a reply that names no model is reported unconfirmed, not as a match', async () => {
  // The dangerous case: silence used to be indistinguishable from agreement.
  let served;
  await withFetch(response({ frames: ['{"completionText":"hi"}'] }),
    () => converse(client(), { modelAlias: 'opus 4.8', onServedModel: (s) => { served = s; } }));
  assert.strictEqual(served.confirmed, false);
  assert.strictEqual(served.served, '');
  assert.strictEqual(served.matches, null);
});

test('a reply that names a model is confirmed exactly once', async () => {
  const seenModels = [];
  await withFetch(response({ frames: ['{"model":"opus-4-8","text":"a"}', '{"model":"opus-4-8","text":"b"}'] }),
    () => converse(client(), { modelAlias: 'opus 4.8', onServedModel: (s) => seenModels.push(s) }));
  assert.strictEqual(seenModels.length, 1);
  assert.strictEqual(seenModels[0].confirmed, true);
  assert.strictEqual(seenModels[0].matches, true);
});

test('the gateway prelude is not mined for a model name', () => {
  // Reading one out of the transport envelope would report a match against a
  // field that describes the HTTP response, not the model that answered.
  assert.strictEqual(modelFrom({ statusCode: 200, headers: { model: 'nginx' } }), '');
});

// --- reading the payload back -----------------------------------------------

test('the payload view shows the model field and hides the credentials', () => {
  const shape = client({
    authHeader: 'Authorization', authPrefix: 'Bearer ', cookie: 'sess=abc',
    modelField: 'engine', identity: { Tenant: 'example.net' },
  }).requestShape({ modelAlias: 'opus 4.8', turns: [{ speaker: 'human', utterance: 'hello there' }] });

  const shown = describeRequest({ ...shape, promptField: 'prompt' });
  assert.match(shown, /"engine": "opus 4\.8"/); // the whole point of looking
  assert.match(shown, /"Tenant": "example\.net"/); // configuration stays visible
  assert.doesNotMatch(shown, /Bearer tok/); // credentials never
  assert.doesNotMatch(shown, /sess=abc/);
  assert.doesNotMatch(shown, /hello there/); // nor the file being worked on
  assert.match(shown, /<prompt, 11 chars, hidden>/);
});

test('key mode shows the shape without any configured values', () => {
  const shape = client({ identity: { Tenant: 'example.net' } })
    .requestShape({ modelAlias: 'opus 4.8', turns: [{ speaker: 'human', utterance: 'hi' }] });

  const shown = describeRequest({ ...shape, promptField: 'prompt' }, { values: false });
  assert.match(shown, /"Tenant": "string"/); // the key, not what is in it
  assert.doesNotMatch(shown, /example\.net/);
});

test('a token limit is a number, not a credential, and stays visible', () => {
  // `max_tokens` contains "token". Hiding it buries a value worth reading and
  // makes the output look like it is withholding more than it is.
  const shown = describeRequest({
    url: 'https://llm.example.com/chat',
    headers: {},
    body: { max_tokens: 4096, maxTokens: '8192', authToken: 'abcdefgh' },
    promptField: 'prompt',
  });
  assert.match(shown, /"max_tokens": 4096/);
  assert.match(shown, /"maxTokens": "8192"/);
  assert.match(shown, /"authToken": "<8 chars, hidden>"/);
});

test('a credential nested inside the identity block is masked too', () => {
  const shown = describeRequest({
    url: 'https://llm.example.com/chat',
    headers: {},
    body: { user: { name: 'A Person', sessionToken: 'super-secret' } },
    promptField: 'prompt',
  });
  assert.doesNotMatch(shown, /super-secret/);
  assert.match(shown, /"name": "A Person"/);
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
    /none of the fields this extension knows about.*unexpected/s,
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

// --- streams that do not put one frame per line -----------------------------

test('objects concatenated with no separator are read as separate frames', async () => {
  const body = '{"statusCode":200,"headers":{"Content-Type":"text/event-stream"}}'
    + '{"completionText":"Hello"}{"completionText":" there"}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.strictEqual(value.text, 'Hello there', 'the envelope must not reach the user');
});

test('an object split across chunks is held until it is complete', async () => {
  const whole = '{"completionText":"Hello there"}';
  for (const at of [5, 18, 25]) {
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader() {
          const parts = [whole.slice(0, at), whole.slice(at)];
          let i = 0;
          return {
            async read() {
              if (i >= parts.length) return { done: true };
              return { done: false, value: new TextEncoder().encode(parts[i++]) };
            },
          };
        },
      },
    };
    const { value } = await withFetch(res, () => converse(client()));
    assert.strictEqual(value.text, 'Hello there', `split at ${at}`);
  }
});

test('braces and quotes inside the text do not end the frame early', async () => {
  const body = '{"completionText":"use { and } and \\" here"}{"completionText":" ok"}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.strictEqual(value.text, 'use { and } and " here ok');
});

test('completionText is auto-detected', async () => {
  const { value } = await withFetch(response({ frames: ['{"completionText":"hi"}'] }),
    () => converse(client()));
  assert.strictEqual(value.text, 'hi');
});

test('a frame carrying no text is skipped silently, not shown', async () => {
  const body = '{"statusCode":200,"headers":{}}{"completionText":"only this"}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.strictEqual(value.text, 'only this');
});

// --- frames that will not parse ----------------------------------------------
// The reader used to show an unreadable frame verbatim, so a reply could open
// with `{"completionText":"I'll impl"}ement Option 1...`. That is worse than a
// missing fragment: it is unreadable, and VS Code replays it as history, so the
// model starts imitating the envelope. Never show one - recover what is in it.

test('an unparseable frame never reaches the user as raw JSON', async () => {
  // A literal newline inside the string is what a backend that concatenates
  // strings instead of serialising emits. JSON forbids it, so the frame is broken.
  const body = '{"completionText":"I\'ll impl\nement Option 1"}{"completionText":" for v3"}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.ok(!value.text.includes('completionText'), `envelope leaked: ${value.text}`);
  assert.strictEqual(value.text, "I'll impl\nement Option 1 for v3");
});

test('a stream cut off mid-frame yields its text, not the fragment', async () => {
  // Exactly what a per-response character cap does: the last frame never closes.
  const body = '{"completionText":"Hello "}{"completionText":"and this is where it stop';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.ok(!value.text.includes('completionText'), `envelope leaked: ${value.text}`);
  assert.strictEqual(value.text, 'Hello and this is where it stop');
});

test('an unreadable frame is reported to the log, since it is not shown', async () => {
  const problems = [];
  const body = '{"completionText":"a\tb"}';
  await withFetch(response({ body }), () => converse(client(), {
    onFrameProblem: (m) => problems.push(m),
  }));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /recovered/);
});

test('an unreadable frame with no text in it is dropped, not printed', async () => {
  const body = '{"statusCode":200,"headers":{"X":"a\nb"}}{"completionText":"the answer"}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.strictEqual(value.text, 'the answer');
});

test('an explicit textPath is honoured when salvaging too', async () => {
  const body = '{"payload":{"deltaText":"one\ntwo"}}';
  const { value } = await withFetch(response({ body }),
    () => converse(client({ textPath: 'payload.deltaText' })));
  assert.strictEqual(value.text, 'one\ntwo');
});

test('a transport envelope is never mined for text, whatever it contains', () => {
  assert.strictEqual(textFrom({ statusCode: 200, headers: {}, message: 'Forbidden' }), '');
  assert.strictEqual(textFrom({ statusCode: 502, headers: {}, data: 'Bad Gateway' }), '');
  // Without the envelope markers these are ordinary frames and still work.
  assert.strictEqual(textFrom({ message: 'hi' }), 'hi');
});

test('salvageText reads a value the parser rejected', () => {
  assert.strictEqual(salvageText('{"completionText":"a\nb"}'), 'a\nb');
  assert.strictEqual(salvageText('{"completionText":"unterminated'), 'unterminated');
  assert.strictEqual(salvageText('{"completionText":"ends in a backslash\\'), 'ends in a backslash');
  assert.strictEqual(salvageText('{"nothing":"useful"}'), '');
});

test('repairJson leaves an already-valid frame untouched', () => {
  const good = '{"completionText":"line one\\nline two"}';
  assert.strictEqual(repairJson(good), good);
});

// --- the NUL padding Lambda puts between its prelude and the payload ----------
// AWS Lambda response streaming ends its prelude with eight NUL bytes. NUL is not
// whitespace, so the first real frame arrives welded to them and misses the JSON
// branch: the reply opened with `{"completionText":"Let me ver"}ify ...` every
// time, on the first frame only, with the NULs rendered as boxes in front.

const NUL = '\u0000'.repeat(8);

test('NUL padding after the prelude does not print the first frame as prose', async () => {
  const body = `{"statusCode":200,"headers":{"Content-Type":"text/event-stream"}}${NUL}`
    + '{"completionText":"Let me ver"}\n{"completionText":"ify the file."}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.ok(!value.text.includes('completionText'), `envelope leaked: ${value.text}`);
  assert.ok(!value.text.includes('\u0000'), 'NUL bytes reached the user');
  assert.strictEqual(value.text, 'Let me verify the file.');
});

test('padded frames work whether or not newlines separate them', async () => {
  const body = `{"statusCode":200,"headers":{}}${NUL}`
    + '{"completionText":"a"}{"completionText":"b"}';
  const { value } = await withFetch(response({ body }), () => converse(client()));
  assert.strictEqual(value.text, 'ab');
});

test('padding split across chunks is still stripped', async () => {
  const whole = `{"statusCode":200,"headers":{}}${NUL}{"completionText":"hello"}`;
  for (const at of [31, 34, 38]) {
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader() {
          const parts = [whole.slice(0, at), whole.slice(at)];
          let i = 0;
          return {
            async read() {
              if (i >= parts.length) return { done: true };
              return { done: false, value: new TextEncoder().encode(parts[i++]) };
            },
          };
        },
      },
    };
    const { value } = await withFetch(res, () => converse(client()));
    assert.strictEqual(value.text, 'hello', `split at ${at}`);
  }
});

test('stripPadding removes NUL and BOM but keeps the text', () => {
  assert.strictEqual(stripPadding(`${NUL}{"a":1}`), '{"a":1}');
  assert.strictEqual(stripPadding('\ufeff\n  hello'), 'hello');
  assert.strictEqual(stripPadding('hello'), 'hello');
});

test('a genuinely plain-text stream still comes through with padding in front', async () => {
  const { value } = await withFetch(response({ body: `${NUL}just words\n` }),
    () => converse(client()));
  assert.strictEqual(value.text, 'just words');
});

// --- which model actually answered -------------------------------------------
// Nothing validates the model name on the way out, and a backend that does not
// recognise it answers with its default rather than an error. These pin the
// read-back that makes that substitution visible.

test('modelFrom finds the served model across the shapes backends use', () => {
  assert.strictEqual(modelFrom({ model: 'gpt-4o' }), 'gpt-4o');
  assert.strictEqual(modelFrom({ modelId: 'internal-7b' }), 'internal-7b');
  assert.strictEqual(modelFrom({ metadata: { model: 'nested-1' } }), 'nested-1');
  assert.strictEqual(modelFrom({ model: 42 }), '');
  assert.strictEqual(modelFrom({ text: 'hi' }), '');
});

test('modelFrom honours an explicit path over the guesses', () => {
  const frame = { model: 'wrapper', payload: { engine: 'real-one' } };
  assert.strictEqual(modelFrom(frame, 'payload.engine'), 'real-one');
});

test('sameModel treats a more specific served name as a match', () => {
  assert.ok(sameModel('gpt-4o', 'gpt-4o-2026-01-15'));
  assert.ok(sameModel('Internal-7B', 'internal_7b'));
  assert.ok(sameModel('opus-5', 'opus5'));
  // Nothing to compare is not a mismatch - most frames name no model at all.
  assert.ok(sameModel('opus-5', ''));
  assert.ok(sameModel('', 'anything'));
});

test('sameModel flags a genuinely different model', () => {
  assert.ok(!sameModel('opus 5.1', 'internal-default-7b'));
  assert.ok(!sameModel('gpt-4o', 'claude-sonnet'));
});

test('converse reports a mismatch when the backend substitutes its default', async () => {
  const seenModels = [];
  await withFetch(
    response({ frames: ['{"model":"internal-default-7b","text":"hi"}'] }),
    () => converse(client(), {
      modelAlias: 'opus 5.1',
      onServedModel: (m) => seenModels.push(m),
    }),
  );
  assert.deepStrictEqual(seenModels, [
    { requested: 'opus 5.1', served: 'internal-default-7b', matches: false, confirmed: true },
  ]);
});

test('converse reports a match without complaining about it', async () => {
  const seenModels = [];
  await withFetch(
    response({ frames: ['{"model":"internal-7b-2026","text":"hi"}'] }),
    () => converse(client(), {
      modelAlias: 'internal-7b',
      onServedModel: (m) => seenModels.push(m),
    }),
  );
  assert.strictEqual(seenModels.length, 1);
  assert.ok(seenModels[0].matches);
});

test('the served model is reported once, not on every frame', async () => {
  const seenModels = [];
  await withFetch(
    response({ frames: ['{"model":"m-1","text":"a"}', '{"model":"m-1","text":"b"}'] }),
    () => converse(client(), {
      modelAlias: 'm-1',
      onServedModel: (m) => seenModels.push(m),
    }),
  );
  assert.strictEqual(seenModels.length, 1);
});

test('a stream that names no model says so rather than passing for a match', async () => {
  // This used to report nothing at all, on the grounds that no evidence is not
  // evidence of a mismatch. True, but it reads as agreement - and "the backend
  // never said" is exactly the state a silent substitution lives in, so it is
  // worth one line of its own.
  const seenModels = [];
  const { value } = await withFetch(
    response({ frames: ['{"text":"hi"}'] }),
    () => converse(client(), {
      modelAlias: 'opus 5.1',
      onServedModel: (m) => seenModels.push(m),
    }),
  );
  assert.deepStrictEqual(seenModels,
    [{ requested: 'opus 5.1', served: '', matches: null, confirmed: false }]);
  assert.strictEqual(value.text, 'hi');
});

/**
 * The auth header name is configurable and this view exists to be pasted to someone
 * else, so a credential must be masked whatever it is called. Real header names are
 * hyphenated, and `X-Api-Key` does not contain "apikey" until the hyphens are removed.
 */
test('a hyphenated credential header is masked, not printed', () => {
  const shown = describeRequest({
    url: 'https://llm.example.com/chat',
    headers: { 'X-Api-Key': 'LEAKED-API-KEY', 'X-Session-Id': 'abcdefgh' },
    body: { jwt: 'JWTVALUE', signature: 'SIGVALUE' },
    promptField: 'prompt',
  });
  for (const leak of ['LEAKED-API-KEY', 'abcdefgh', 'JWTVALUE', 'SIGVALUE']) {
    assert.doesNotMatch(shown, new RegExp(leak));
  }
});

/** Over-masking is the other failure: this view exists to show the model field. */
test('configuration that merely looks credential-ish stays visible', () => {
  const shown = describeRequest({
    url: 'https://llm.example.com/chat',
    headers: {},
    body: { model: 'alpha-1', design: 'compact', assignee: 'team-b', max_tokens: 4096 },
    promptField: 'prompt',
  });
  assert.match(shown, /"model": "alpha-1"/);
  assert.match(shown, /"design": "compact"/);
  assert.match(shown, /"assignee": "team-b"/);
  assert.match(shown, /"max_tokens": 4096/);
});
