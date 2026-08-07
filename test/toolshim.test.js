/**
 * Deterministic checks for the tool-call scanner. The E2E suite proves the wiring
 * against a live model, but what a model emits varies run to run - the awkward
 * shapes it produces are pinned here instead.
 *
 *   node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { ToolCallScanner, buildToolPrompt } = require('../src/toolshim');

/** Feed text through the scanner one chunk at a time, as a stream would. */
function scan(chunks) {
  const scanner = new ToolCallScanner();
  let text = '';
  const calls = [];
  for (const chunk of [].concat(chunks)) {
    const out = scanner.push(chunk);
    text += out.text;
    calls.push(...out.calls);
  }
  const rest = scanner.flush();
  text += rest.text;
  calls.push(...rest.calls);
  return { text, calls };
}

const CALL = '{"name": "read_file", "arguments": {"path": "package.json"}}';

test('a well-formed tagged call becomes a tool call, not text', () => {
  const { text, calls } = scan(`<tool_call>${CALL}</tool_call>`);
  assert.strictEqual(text, '');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, 'read_file');
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'package.json' });
});

test('a tag split across chunks never leaks a partial tag', () => {
  const whole = `Here goes: <tool_call>${CALL}</tool_call>`;
  for (const at of [12, 15, 20, 31, 60]) {
    const { text, calls } = scan([whole.slice(0, at), whole.slice(at)]);
    assert.strictEqual(text, 'Here goes: ', `split at ${at}`);
    assert.strictEqual(calls.length, 1, `split at ${at}`);
  }
});

test('a mangled closing tag is still parsed as a call', () => {
  // Observed from a real model: "</tool_call}" instead of "</tool_call>".
  for (const close of ['</tool_call}', '</tool_call', '</tool_call>', '']) {
    const { text, calls } = scan(`<tool_call>${CALL}${close}`);
    assert.strictEqual(calls.length, 1, `close=${JSON.stringify(close)}`);
    assert.strictEqual(text, '', `close=${JSON.stringify(close)}`);
    assert.strictEqual(calls[0].function.name, 'read_file');
  }
});

test('an untagged bare JSON call is recognised', () => {
  const { text, calls } = scan(CALL);
  assert.strictEqual(text, '');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'package.json' });
});

test('a bare call arriving in pieces is held back until it parses', () => {
  const scanner = new ToolCallScanner();
  const first = scanner.push(CALL.slice(0, 20));
  assert.strictEqual(first.text, '', 'half an object must not be streamed out as prose');
  assert.strictEqual(first.calls.length, 0);
  const second = scanner.push(CALL.slice(20));
  assert.strictEqual(second.calls.length, 1);
});

test('prose that merely starts with a brace is released as text', () => {
  const prose = '{"name": "a curly brace walks into a bar" — and then the rest of the answer.';
  assert.strictEqual(scan(prose).text, prose);
  assert.strictEqual(scan(prose).calls.length, 0);
});

test('ordinary prose passes through untouched', () => {
  const prose = 'No tools needed here.\nJust an answer, with a < and a { in it.';
  const { text, calls } = scan(prose.split(/(?<=\n)/));
  assert.strictEqual(text, prose);
  assert.strictEqual(calls.length, 0);
});

test('a tagged call that is not JSON is shown so the model can self-correct', () => {
  const { text, calls } = scan('<tool_call>read the file please</tool_call>');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(text, '<tool_call>read the file please</tool_call>');
});

test('text before and after a call is preserved in order', () => {
  const { text, calls } = scan(`Let me look. <tool_call>${CALL}</tool_call> Done.`);
  assert.strictEqual(text, 'Let me look.  Done.');
  assert.strictEqual(calls.length, 1);
});

test('two calls in one response both come through with distinct ids', () => {
  const { calls } = scan(`<tool_call>${CALL}</tool_call><tool_call>${CALL}</tool_call>`);
  assert.strictEqual(calls.length, 2);
  assert.notStrictEqual(calls[0].id, calls[1].id);
});

test('a call missing a name is not treated as a call', () => {
  const { text, calls } = scan('<tool_call>{"arguments": {"path": "x"}}</tool_call>');
  assert.strictEqual(calls.length, 0);
  assert.match(text, /arguments/);
});

test('the tool prompt lists every tool by name', () => {
  const prompt = buildToolPrompt([
    { name: 'read_file', description: 'read it', parameters: { type: 'object' } },
    { function: { name: 'write_file', description: 'write it' } },
  ]);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /write_file/);
  assert.match(prompt, /<tool_call>/);
});
