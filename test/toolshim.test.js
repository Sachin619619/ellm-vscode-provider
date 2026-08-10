/**
 * Deterministic checks for the tool-call scanner. The E2E suite proves the wiring
 * against a live model, but what a model emits varies run to run - the awkward
 * shapes it produces are pinned here instead.
 *
 *   node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ToolCallScanner, buildToolPrompt, restartsToolCall, dropOpenToolCall,
} = require('../src/toolshim');

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

// --- calls a strict parser throws away --------------------------------------
// On Windows every file-path argument is invalid JSON, because the model writes
// the path the way the OS spells it. A strict parse threw, the call was shown to
// the user as raw text, the edit never ran, nothing told the model why, and it
// reissued the same call. These pin the repair.

test('a Windows path in the arguments does not throw the call away', () => {
  const raw = String.raw`{"name":"replace_string_in_file","arguments":{"filePath":"c:\Users\dev\proj\docs\notes.md","oldString":"a","newString":"b"}}`;
  const { text, calls } = scan(`<tool_call>${raw}</tool_call>`);

  assert.strictEqual(text, '', 'the call leaked into the chat as text');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, 'replace_string_in_file');
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), {
    filePath: 'c:\\Users\\dev\\proj\\docs\\notes.md',
    oldString: 'a',
    newString: 'b',
  });
});

test('valid escapes inside a repaired call keep their meaning', () => {
  // \n is a newline the model meant; \U is a backslash it did not escape. Both
  // appear in the same argument, and the repair has to tell them apart.
  const raw = String.raw`{"name":"edit","arguments":{"path":"c:\tmp\x.md","body":"one\ntwo\ttabbed","q":"say \"hi\""}}`;
  const { calls } = scan(`<tool_call>${raw}</tool_call>`);

  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), {
    path: 'c:\\tmp\\x.md',
    body: 'one\ntwo\ttabbed',
    q: 'say "hi"',
  });
});

test('an unescaped newline inside an argument is repaired, not dropped', () => {
  const raw = '{"name":"write","arguments":{"body":"line one\nline two"}}';
  const { calls } = scan(`<tool_call>${raw}</tool_call>`);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { body: 'line one\nline two' });
});

test('an untagged bare call with a Windows path is still recognised', () => {
  const raw = String.raw`{"name":"read_file","arguments":{"path":"c:\Users\dev\a.txt"}}`;
  const { text, calls } = scan(raw);
  assert.strictEqual(text, '');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'c:\\Users\\dev\\a.txt' });
});

test('repair does not turn genuine prose into a tool call', () => {
  const { text, calls } = scan('{"name": not json at all');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(text, '{"name": not json at all');
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

test('a tagged call that is not JSON is reported, not dumped into the chat', () => {
  const { text, calls } = scan('<tool_call>read the file please</tool_call>');
  assert.strictEqual(calls.length, 0);
  assert.doesNotMatch(text, /<tool_call>/, 'the markup itself must not reach the chat');
  assert.match(text, /could not be run/);
  // The model reads this back as its own previous turn - it has to say what to fix.
  assert.match(text, /valid JSON/);
  assert.match(text, /read the file please/, 'enough of the call to recognise which one');
});

test('a call cut off mid-write is reported with its length, not its body', () => {
  const half = `<tool_call>{"name":"create_file","arguments":{"content":"${'x'.repeat(4000)}`;
  const { text, calls } = scan(half);
  assert.strictEqual(calls.length, 0);
  assert.ok(text.length < 500, `a 4000-char body must not land in the chat (got ${text.length})`);
  assert.match(text, /stopped before it finished/);
  assert.match(text, /smaller pieces/);
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

// --- a file body inside a JSON string ---------------------------------------
//
// Asking a model to put a source file in a JSON string gets a source file back,
// quotes and all. These are the shapes that used to make the whole call render
// as markup in the chat while the file was never written and nothing said so.

test('a call carrying a Python docstring is still a call', () => {
  const raw = String.raw`<tool_call>{"name":"create_file","arguments":{"filePath":"docs/gen.py","content":"""Generate a deck.\n\nRun: python gen.py\n"""\n\nimport os\n"}}</tool_call>`;
  const { text, calls } = scan(raw);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(text, ''); // never leaks into the chat as markup
  assert.strictEqual(calls[0].function.name, 'create_file');
  const args = JSON.parse(calls[0].function.arguments);
  // One quote is gone for good and no parser can get it back: of the `"""` the
  // model wrote, the first had to be the quote that opens the JSON string. What
  // matters is that the call runs at all - a file needing one fix beats a call
  // rendered as markup that wrote nothing and told nobody.
  assert.ok(args.content.startsWith('""Generate a deck.'), args.content.slice(0, 20));
  assert.match(args.content, /import os/); // the body after the docstring survives
});

test('quotes inside the file body do not truncate it', () => {
  // `"alpha",` looks exactly like the end of a string until you try to read
  // what follows it and find no key and no colon.
  const raw = String.raw`<tool_call>{"name":"create_file","arguments":{"path":"a.py","content":"rows = [[\"one\", \"two\"], [\"three\"]]\nfont = \"Segoe UI\"\n"}}</tool_call>`
    .replace(/\\"/g, '"'); // strip the escaping the model failed to add
  const { calls } = scan(raw);

  assert.strictEqual(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments);
  assert.match(args.content, /rows = \[\["one", "two"\], \["three"\]\]/);
  assert.match(args.content, /font = "Segoe UI"/);
});

test('a Windows path and unescaped quotes survive together', () => {
  const raw = String.raw`<tool_call>{"name":"create_file","arguments":{"filePath":"C:\Users\dev\gen.py","content":"x = "hi"\n"}}</tool_call>`;
  const { calls } = scan(raw);

  assert.strictEqual(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments);
  assert.strictEqual(args.filePath, 'C:\\Users\\dev\\gen.py');
  assert.strictEqual(args.content, 'x = "hi"\n');
});

test('genuine prose is still not mistaken for a tool call', () => {
  const { text, calls } = scan('Here is what I would do: {"name": not json at all');
  assert.strictEqual(calls.length, 0);
  assert.match(text, /Here is what I would do/);
});

test('the tool prompt says how to escape a quote', () => {
  assert.match(buildToolPrompt([{ name: 'x' }]), /\\"/);
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

// --- a continuation that starts the call over instead of finishing it --------

test('a fresh call only counts as a restart when one was left open', () => {
  const open = '<tool_call>{"name":"create_file","arguments":{"content":"half';
  assert.ok(restartsToolCall(open, '<tool_call>{"name":"create_file"'));
  // Nothing outstanding: a second call after a finished one is normal, not a restart.
  assert.strictEqual(restartsToolCall(`${open}"}}</tool_call>`, '<tool_call>{"name":"x"}'), false);
  // The honest case - the continuation really does carry on mid-JSON.
  assert.strictEqual(restartsToolCall(open, ' of the file"}}</tool_call>'), false);
  // A closing tag before the next opening one means it finished this call first.
  assert.strictEqual(restartsToolCall(open, '"}}</tool_call> and <tool_call>{"name":"y"}'), false);
});

test('dropping the open call leaves the text before it untouched', () => {
  const text = 'Writing the file now.\n<tool_call>{"name":"create_file","arguments":{"co';
  assert.strictEqual(dropOpenToolCall(text), 'Writing the file now.\n');
  assert.strictEqual(dropOpenToolCall('no call here'), 'no call here');
});

test('the scanner forgets an abandoned call instead of splicing it onto the new one', () => {
  const scanner = new ToolCallScanner();
  scanner.push('<tool_call>{"name":"create_file","arguments":{"filePath":"a.py","content":"firs');
  scanner.dropOpenCall();

  const out = scanner.push(
    '<tool_call>{"name":"create_file","arguments":{"filePath":"a.py","content":"first half\\nsecond half\\n"}}</tool_call>',
  );
  assert.strictEqual(out.calls.length, 1);
  const args = JSON.parse(out.calls[0].function.arguments);
  assert.strictEqual(args.content, 'first half\nsecond half\n', 'no duplicated fragment');
  assert.deepStrictEqual(scanner.flush(), { text: '', calls: [] });
});

// --- what the prompt asks for -----------------------------------------------

/**
 * Serialising every call cost a full round trip each - through a capped, stitched
 * transport - and that is most of why a task took many more turns here than on a
 * model with native tool calling. The permission to batch has to survive edits to
 * the prompt, so it is pinned.
 */
test('the tool prompt allows independent calls to be batched into one reply', () => {
  const prompt = buildToolPrompt([{ name: 'read_file', description: 'read', parameters: {} }]);
  assert.match(prompt, /emit them all in one reply/i);
  assert.doesNotMatch(prompt, /one tool call at a time/i);
});

test('a dependent call, and a call carrying a file, are still sent alone', () => {
  const prompt = buildToolPrompt([{ name: 'create_file', description: 'write', parameters: {} }]);
  assert.match(prompt, /depends on what it returns/i);
  assert.match(prompt, /large file body/i);
});

/**
 * Required means the caller cannot use prose: it is waiting for a call and treats
 * an answer as a failed turn. Before this the mode was read nowhere.
 */
test('tool mode Required tells the model it must call a tool', () => {
  const prompt = buildToolPrompt([{ name: 'edit', description: '', parameters: {} }], { required: true });
  assert.match(prompt, /MUST call a tool/);
  assert.doesNotMatch(prompt, /just answer normally/i);
});

test('without Required the model may still answer in prose', () => {
  const prompt = buildToolPrompt([{ name: 'edit', description: '', parameters: {} }]);
  assert.match(prompt, /just answer normally/i);
  assert.doesNotMatch(prompt, /MUST call a tool/);
});

/**
 * The prompt is appended after the whole conversation, so it is the last thing the
 * model reads. That is why calls come back well-formed - and why it has to hand
 * attention back, or a model given a tool manual as the final word reaches for a
 * tool when it should simply answer.
 */
test('the tool prompt ends by pointing back at the conversation', () => {
  const prompt = buildToolPrompt([{ name: 'read_file', description: '', parameters: {} }]);
  assert.match(prompt.trim().split('\n').pop(), /most recent request above/i);
});
