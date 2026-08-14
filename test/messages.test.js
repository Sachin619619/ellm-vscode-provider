/**
 * The conversation array, and the flattened prompt it replaces.
 *
 * The risk this pins is not a crash. A backend handed a body field it does not
 * recognise ignores it and answers from whatever it did understand, so turning the
 * array on against a backend that wants a string produces a normal-looking reply
 * to an empty conversation. Nothing downstream can detect that, which is why the
 * request side is what gets asserted here.
 *
 *   node --test test/*.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { CorpClient, describeRequest } = require('../src/corpClient');

const TURNS = [
  { speaker: 'system', utterance: 'You are a coding agent.' },
  { speaker: 'human', utterance: 'Fix the bug in auth.js' },
  { speaker: 'assistant', utterance: 'Reading it now.' },
  { speaker: 'human', utterance: 'TOOL RESULT (1): export function auth() {}' },
];

const base = { url: 'http://127.0.0.1:9800', token: 't', models: ['m1'] };

test('by default the conversation is one flattened prompt, as before', () => {
  const body = new CorpClient(base).body({ modelAlias: 'm1', turns: TURNS });

  assert.strictEqual(typeof body.prompt, 'string');
  assert.ok(!Array.isArray(body.messages), 'no array field appears unless asked for');
  assert.match(body.prompt, /^System: You are a coding agent\./);
  assert.match(body.prompt, /User: Fix the bug in auth\.js/);
  assert.match(body.prompt, /Assistant: Reading it now\./);
});

test('naming a messages field sends a real array instead of the prompt', () => {
  const body = new CorpClient({ ...base, messagesField: 'messages' })
    .body({ modelAlias: 'm1', turns: TURNS });

  assert.deepStrictEqual(body.messages, [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Fix the bug in auth.js' },
    { role: 'assistant', content: 'Reading it now.' },
    { role: 'user', content: 'TOOL RESULT (1): export function auth() {}' },
  ]);
  // Both at once would put every turn in the body twice, and a backend reading
  // both answers a conversation it has been shown double.
  assert.ok(!('prompt' in body), 'the flattened prompt must not be sent as well');
});

test('the speaker format keeps the corp spelling of a turn', () => {
  const body = new CorpClient({
    ...base, messagesField: 'turns', messagesFormat: 'speaker',
  }).body({ modelAlias: 'm1', turns: TURNS });

  assert.deepStrictEqual(body.turns[0], { speaker: 'system', utterance: 'You are a coding agent.' });
  assert.deepStrictEqual(body.turns[1], { speaker: 'human', utterance: 'Fix the bug in auth.js' });
});

test('the anthropic format hoists system out of the array', () => {
  const body = new CorpClient({
    ...base, messagesField: 'messages', messagesFormat: 'anthropic',
  }).body({ modelAlias: 'm1', turns: TURNS });

  // Left inline, a system turn reads as the user talking - the instructions stop
  // being instructions, which is the whole thing the array was meant to fix.
  assert.strictEqual(body.system, 'You are a coding agent.');
  assert.ok(body.messages.every((m) => m.role !== 'system'), 'no system role in the array');
  assert.deepStrictEqual(body.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'Fix the bug in auth.js' }],
  });
});

test('an unknown format falls back rather than sending a shape nobody handles', () => {
  const client = new CorpClient({ ...base, messagesField: 'messages', messagesFormat: 'nonsense' });
  assert.strictEqual(client.messagesFormat, 'openai');
});

test('the picked model still wins, and stream is still set, in array mode', () => {
  const body = new CorpClient({
    ...base,
    messagesField: 'messages',
    identity: { model: 'stale-from-devtools', tenant: 'acme' },
  }).body({ modelAlias: 'm1', turns: TURNS });

  assert.strictEqual(body.model, 'm1');
  assert.strictEqual(body.tenant, 'acme');
  assert.strictEqual(body.stream, true);
});

test('an image note still reaches the array when the backend takes no images', () => {
  const turns = [{ speaker: 'human', utterance: 'what does this say?', images: [{ mimeType: 'image/png', data: 'AAAA' }] }];
  const body = new CorpClient({ ...base, messagesField: 'messages' })
    .body({ modelAlias: 'm1', turns });

  // Silently dropping it leaves the model answering about a picture it never got,
  // and a model in that position invents one rather than admitting the gap.
  assert.match(body.messages[0].content, /attached image/);
  assert.match(body.messages[0].content, /cannot receive images/);
});

test('the request view shows roles and sizes, never the conversation itself', () => {
  const client = new CorpClient({ ...base, messagesField: 'messages' });
  const shape = client.requestShape({ modelAlias: 'm1', turns: TURNS });
  const shown = describeRequest({
    url: shape.url,
    body: shape.body,
    headers: shape.headers,
    promptField: client.promptField,
    messagesField: client.messagesField,
  });

  // This view exists to be pasted to someone else for diagnosis. In array mode the
  // conversation is every file the agent has read, so it gets the same summary the
  // flattened prompt already got.
  assert.match(shown, /system\(23 chars\)/);
  assert.match(shown, /user\(22 chars\)/);
  assert.doesNotMatch(shown, /You are a coding agent/);
  assert.doesNotMatch(shown, /Fix the bug in auth\.js/);
});

test('the flattened prompt is still hidden in the request view', () => {
  const client = new CorpClient(base);
  const shape = client.requestShape({ modelAlias: 'm1', turns: TURNS });
  const shown = describeRequest({
    url: shape.url,
    body: shape.body,
    headers: shape.headers,
    promptField: client.promptField,
    messagesField: client.messagesField,
  });

  assert.match(shown, /<prompt, \d+ chars, hidden>/);
  assert.doesNotMatch(shown, /You are a coding agent/);
});
