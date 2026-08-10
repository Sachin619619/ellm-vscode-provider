/**
 * Stitching a capped response back together, and knowing when it is not finished.
 *
 * The failure these exist for: a file write arrives over many capped rounds, and
 * a backend that reports a clean stop for a capped response ends the answer
 * mid-JSON. The tool call then cannot parse, gets rendered into the chat as
 * markup, and the file is never written - with nothing saying why.
 *
 *   node --test test/*.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { withContinuation } = require('../src/continuation');
const { hasOpenToolCall } = require('../src/toolshim');

/** A fake upstream that replays `rounds`, one per call. */
function upstream(rounds) {
  let i = 0;
  const seen = [];
  const call = async function* call(turns) {
    seen.push(turns);
    const round = rounds[i++] ?? { text: '', finish: 'stop' };
    if (round.text) yield { type: 'text', text: round.text };
    yield { type: 'finish', reason: round.finish };
  };
  return { call, seen, rounds: () => i };
}

async function drain(stream) {
  let text = '';
  for await (const ev of stream) if (ev.type === 'text') text += ev.text;
  return text;
}

test('a clean stop ends the answer when nothing is outstanding', async () => {
  const up = upstream([{ text: 'All done.', finish: 'stop' }]);
  const text = await drain(withContinuation(up.call, [], { needsMore: hasOpenToolCall }));

  assert.strictEqual(text, 'All done.');
  assert.strictEqual(up.rounds(), 1, 'nothing was outstanding, so do not ask again');
});

test('an unclosed tool call keeps going despite a clean stop reason', async () => {
  // The backend says it finished. It did not: the call has no closing tag, so
  // the answer is provably mid-write whatever the stop reason claims.
  const up = upstream([
    { text: '<tool_call>{"name":"create_file","arguments":{"content":"line one', finish: 'stop' },
    { text: '\\nline two"}}</tool_call>', finish: 'stop' },
  ]);
  const text = await drain(withContinuation(up.call, [], { needsMore: hasOpenToolCall }));

  assert.strictEqual(up.rounds(), 2, 'the unfinished call should have forced another round');
  assert.ok(text.includes('</tool_call>'), text);
  assert.strictEqual(hasOpenToolCall(text), false);
});

test('without the predicate the same answer stops half-written', async () => {
  // This is the old behaviour, kept as the reason the predicate exists.
  const up = upstream([
    { text: '<tool_call>{"name":"create_file","arguments":{"content":"line one', finish: 'stop' },
    { text: '\\nline two"}}</tool_call>', finish: 'stop' },
  ]);
  const text = await drain(withContinuation(up.call, [], {}));

  assert.strictEqual(up.rounds(), 1);
  assert.strictEqual(hasOpenToolCall(text), true, 'left mid-call, which is what broke the file write');
});

test('continuing stops once the call is closed, not one round later', async () => {
  const up = upstream([
    { text: '<tool_call>{"name":"x","arguments":{}}</tool_call>', finish: 'stop' },
    { text: 'should never be asked for', finish: 'stop' },
  ]);
  const text = await drain(withContinuation(up.call, [], { needsMore: hasOpenToolCall }));

  assert.strictEqual(up.rounds(), 1);
  assert.ok(!text.includes('never be asked'));
});

test('the continuation limit is respected even with a call still open', async () => {
  const forever = Array.from({ length: 10 }, () => ({ text: 'x', finish: 'stop' }));
  forever[0] = { text: '<tool_call>{"name":"x"', finish: 'stop' };
  const up = upstream(forever);
  const notes = [];

  await drain(withContinuation(up.call, [], {
    needsMore: hasOpenToolCall, maxContinuations: 3, log: (m) => notes.push(m),
  }));

  assert.ok(up.rounds() <= 5, `ran ${up.rounds()} rounds`);
  assert.ok(notes.some((n) => /STILL unfinished/.test(n)), notes.join(' | '));
});

test('hasOpenToolCall only reports a call that was never closed', () => {
  assert.strictEqual(hasOpenToolCall('plain prose'), false);
  assert.strictEqual(hasOpenToolCall('<tool_call>{"a":1}</tool_call>'), false);
  assert.strictEqual(hasOpenToolCall('<tool_call>{"a":1'), true);
  assert.strictEqual(hasOpenToolCall('<tool_call>{}</tool_call> then <tool_call>{"b"'), true);
});

// --- when "continue" is answered by starting over ----------------------------

const { restartsToolCall, dropOpenToolCall, ToolCallScanner } = require('../src/toolshim');

/** Consume the stream the way the provider does, honouring the restart event. */
async function drainAsProvider(stream) {
  const scanner = new ToolCallScanner();
  let text = '';
  const calls = [];
  let restarts = 0;

  for await (const ev of stream) {
    if (ev.type === 'restart') {
      restarts++;
      scanner.dropOpenCall();
      continue;
    }
    if (ev.type !== 'text') continue;
    const out = scanner.push(ev.text);
    text += out.text;
    calls.push(...out.calls);
  }
  const rest = scanner.flush();
  return { text: text + rest.text, calls: calls.concat(rest.calls), restarts };
}

/**
 * The realistic shape: the half already written is longer than the de-dup window,
 * so the overlap stripper cannot see that the restart repeats it. (When the model
 * repeats a *short* half verbatim, stripOverlap stitches it and there is nothing
 * to restart.)
 */
const BODY = 'print(1)\\n'.repeat(70);
const HALF = `<tool_call>{"name":"create_file","arguments":{"filePath":"a.py","content":"${BODY}`;
const WHOLE = `<tool_call>{"name":"create_file","arguments":{"filePath":"a.py","content":"${BODY}print(2)\\n"}}</tool_call>`;

test('a restarted tool call replaces the half it abandoned', async () => {
  // Cut off mid-argument, and the backend calls it a clean stop; asked to
  // continue, the model writes the whole call again instead.
  const up = upstream([{ text: HALF, finish: 'stop' }, { text: WHOLE, finish: 'stop' }]);

  const out = await drainAsProvider(withContinuation(up.call, [], {
    needsMore: hasOpenToolCall, restarted: restartsToolCall, dropStale: dropOpenToolCall,
  }));

  assert.strictEqual(out.restarts, 1);
  assert.strictEqual(out.calls.length, 1, 'one call, not two halves of one');
  assert.strictEqual(
    JSON.parse(out.calls[0].function.arguments).content,
    'print(1)\n'.repeat(70) + 'print(2)\n',
    'the abandoned fragment must not be spliced into the file',
  );
  assert.strictEqual(out.text, '', 'no markup in the chat');
});

test('an honest continuation is not mistaken for a restart', async () => {
  const up = upstream([
    { text: '<tool_call>{"name":"create_file","arguments":{"filePath":"a.py","content":"one\\n', finish: 'length' },
    { text: 'two\\n"}}</tool_call>', finish: 'stop' },
  ]);

  const out = await drainAsProvider(withContinuation(up.call, [], {
    needsMore: hasOpenToolCall, restarted: restartsToolCall, dropStale: dropOpenToolCall,
  }));

  assert.strictEqual(out.restarts, 0);
  assert.strictEqual(out.calls.length, 1);
  assert.strictEqual(JSON.parse(out.calls[0].function.arguments).content, 'one\ntwo\n');
});

test('the restart hooks stay off unless both are supplied', async () => {
  const up = upstream([
    { text: '<tool_call>{"name":"x","arguments":{"a":"1', finish: 'stop' },
    { text: '<tool_call>{"name":"x","arguments":{"a":"1"}}</tool_call>', finish: 'stop' },
  ]);

  // restarted without dropStale would trim nothing while claiming a restart.
  const out = await drainAsProvider(withContinuation(up.call, [], {
    needsMore: hasOpenToolCall, restarted: restartsToolCall,
  }));
  assert.strictEqual(out.restarts, 0);
});
