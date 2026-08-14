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

// --- the response budget ----------------------------------------------------
// Everything else about the upstream cap recovers from it AFTER the fact: the
// continuation layer stitches the halves, dropOpenToolCall drops a restarted call,
// the JSON repair fixes what a cut left behind. Nothing told the model the limit
// existed, so it wrote to no budget and was guillotined mid-JSON on any real file.

test('the model is given a budget under the cap, not the cap itself', () => {
  const { budgetFor } = require('../src/toolshim');
  assert.strictEqual(budgetFor(5000), 4500);
  const prompt = buildToolPrompt([{ name: 'create_file', description: '', parameters: {} }], {
    budgetChars: budgetFor(5000),
  });
  assert.match(prompt, /under 4500 characters/);
  assert.doesNotMatch(prompt, /under 5000 characters/);
});

test('the budget tracks a backend configured with a different cap', () => {
  const { budgetFor } = require('../src/toolshim');
  assert.strictEqual(budgetFor(8000), 7500);
  assert.strictEqual(budgetFor(600), 300);
  assert.strictEqual(budgetFor(0), 0);
});

test('a large file is split across calls, with room left for escaping', () => {
  const prompt = buildToolPrompt([{ name: 'create_file', description: '', parameters: {} }], {
    budgetChars: 4500,
  });
  assert.match(prompt, /must NEVER be cut off/i);
  assert.match(prompt, /about 3150 characters of file content/);
  assert.match(prompt, /Escaping makes the JSON longer/i);
});

test('no budget means no budget rules, and the rest of the protocol is unchanged', () => {
  const prompt = buildToolPrompt([{ name: 'x' }]);
  assert.doesNotMatch(prompt, /Keep each reply under/);
  assert.match(prompt, /one tool call at a time/);
  assert.match(prompt, /just answer in plain text/);
});

/**
 * Shapes a chat-tuned model actually emits instead of the protocol it was taught.
 *
 * Measured before these were handled: 7 of 13 printed the call into the chat as raw
 * markup and never ran it, and 3 more produced a call the tool could not accept. The
 * user-visible symptom is the same for all ten - "it isn't using tools, and the tool
 * calls leak into the chat" - so they are pinned together.
 */
const TOOLS = ['read_file', 'write_file', 'run_in_terminal'];

/** As `scan`, but with the offered tool names the provider passes in real use. */
function scanKnown(chunks, names = TOOLS) {
  const scanner = new ToolCallScanner(null, names);
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

const BARE = '{"name":"read_file","arguments":{"path":"a.js"}}';

/** Chunked the way a stream delivers it, so a shape cannot pass by arriving whole. */
const inPieces = (s) => s.match(/[\s\S]{1,17}/g) ?? [];

test('a call wrapped in a markdown fence leaves no fence in the chat', () => {
  for (const raw of [
    '```\n<tool_call>' + BARE + '</tool_call>\n```',
    '```json\n' + BARE + '\n```',
    'Let me check.\n\n```json\n' + BARE + '\n```\n',
  ]) {
    const { text, calls } = scanKnown(inPieces(raw));
    assert.strictEqual(calls.length, 1, raw);
    assert.doesNotMatch(text, /```/, raw);
  }
});

test('the tags are matched as a shape, not as one exact string', () => {
  for (const raw of [
    `<tool_call >${BARE}</tool_call>`,
    `<tool-call>${BARE}</tool-call>`,
    `<TOOL_CALL>${BARE}</TOOL_CALL>`,
    `<tool_use>${BARE}</tool_use>`,
    `<function_call>${BARE}</function_call>`,
  ]) {
    const { text, calls } = scanKnown(inPieces(raw));
    assert.strictEqual(calls.length, 1, raw);
    assert.strictEqual(text, '', raw);
  }
});

test('an untagged call is found after prose, not only at the very start', () => {
  const { text, calls } = scanKnown(inPieces('I will read the file now.\n' + BARE));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, 'read_file');
  assert.doesNotMatch(text, /"name"/);
});

test('an untagged call between two pieces of prose keeps both', () => {
  const { text, calls } = scanKnown(inPieces(`Sure.\n\n${BARE}\n\nThat should do it.`));
  assert.strictEqual(calls.length, 1);
  assert.match(text, /^Sure\./);
  assert.match(text, /That should do it\.$/);
  assert.doesNotMatch(text, /"name"/);
});

test('arguments arriving as a JSON string become the object the tool expects', () => {
  const raw = '<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"a.js\\"}"}</tool_call>';
  const { calls } = scanKnown(inPieces(raw));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'a.js' });
});

test('a namespaced name resolves to the tool that was actually offered', () => {
  const { calls } = scanKnown(`<tool_call>{"name":"functions.read_file","arguments":{}}</tool_call>`);
  assert.strictEqual(calls[0].function.name, 'read_file');
});

test('the near-miss key names a model reaches for still make a call', () => {
  for (const key of ['tool_name', 'toolName', 'recipient_name']) {
    const { calls } = scanKnown(`<tool_call>{"${key}":"read_file","arguments":{}}</tool_call>`);
    assert.strictEqual(calls.length, 1, key);
    assert.strictEqual(calls[0].function.name, 'read_file', key);
  }
  for (const key of ['parameters', 'args', 'input']) {
    const { calls } = scanKnown(`<tool_call>{"name":"read_file","${key}":{"path":"a.js"}}</tool_call>`);
    assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'a.js' }, key);
  }
});

test('the OpenAI envelope a model copies from memory is unwrapped', () => {
  const raw = '<tool_call>{"type":"function","function":{"name":"read_file",'
    + '"arguments":{"path":"a.js"}}}</tool_call>';
  const { calls } = scanKnown(inPieces(raw));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, 'read_file');
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'a.js' });
});

test('a list of calls is read as calls, not dropped as the wrong shape', () => {
  const raw = `<tool_call>[${BARE},{"name":"write_file","arguments":{"path":"b.js"}}]</tool_call>`;
  const { calls } = scanKnown(inPieces(raw));
  assert.deepStrictEqual(calls.map((c) => c.function.name), ['read_file', 'write_file']);
});

/**
 * The other half of finding untagged calls: an object naming something the client
 * cannot run is an example, and an answer about JSON must survive being given.
 */
test('untagged JSON naming no offered tool stays in the chat as text', () => {
  const example = 'Here is the shape:\n{"name":"some_service","arguments":{"a":1}}\nUse it as a guide.';
  const { text, calls } = scanKnown(inPieces(example));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(text, example);
});

test('a truncated call is reported, but truncated prose is still delivered', () => {
  const cut = '<tool_call>{"name":"write_file","arguments":{"content":"half a fi';
  assert.match(scanKnown(inPieces(cut)).text, /could not be run/);

  const prose = '{"name": "a curly brace walks into a bar" and the rest of the answer.';
  assert.strictEqual(scanKnown(inPieces(prose)).text, prose);
});

test('the protocol tells the model to finish the task instead of checking in', () => {
  const prompt = buildToolPrompt([{ name: 'read_file', description: '', parameters: {} }]);
  assert.match(prompt, /automated agent loop/i);
  assert.match(prompt, /not ask permission/i);
  assert.match(prompt, /TOOL RESULT/);
  assert.match(prompt, /never end a turn with a question/i);
  assert.match(prompt, /must be a JSON object, not a string/i);
});

/**
 * The block above is prepended, and this backend truncates from the front, so every
 * character it costs is a character of headroom the user's request loses. The first
 * version ran to nine bullets and grew the protocol by 1202 chars - shipped in
 * v0.6.0, and the most likely reason a real agent started answering every prompt
 * with the same sentence. Size is a property worth asserting, not just wording.
 */
test('the working-the-task block does not grow the protocol back', () => {
  const tools = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Do the tool_${i} operation in the workspace, returning results.`,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'what to look for' } },
      required: ['query'],
    },
  }));
  const prompt = buildToolPrompt(tools, { budgetChars: 4500 });
  const guidance = prompt.slice(prompt.indexOf('Working the task:'));

  assert.ok(guidance.length < 700,
    `the guidance block is ${guidance.length} chars; it is prepended, so keep it small`);
});

test('an untagged call cut off mid-write keeps the continuation going', () => {
  const { hasUnfinishedCall } = require('../src/toolshim');
  const cut = 'Writing it now.\n{"name":"write_file","arguments":{"content":"half a fi';

  assert.strictEqual(hasUnfinishedCall(cut, TOOLS), true, 'a cut-off call must be continued');
  assert.strictEqual(
    hasUnfinishedCall(`${cut}le"}}`, TOOLS), false, 'a finished call must not be',
  );
  assert.strictEqual(
    hasUnfinishedCall('The config is {"name":"my service" and it goes on', TOOLS), false,
    'prose naming no offered tool must not buy extra round trips',
  );
  assert.strictEqual(
    hasUnfinishedCall(`<tool_call>${BARE}`, TOOLS), true, 'the tagged case still works',
  );
});

/**
 * The bug this pins passed every fixed-boundary test and failed on most random ones.
 *
 * `{"name":` is eight characters and a stream delivers a few at a time, so the buffer
 * is `{"na` when it is looked at - too little to recognise, and every character of it
 * went to the chat as prose before the rest of the call arrived. Whether a call leaked
 * came down to where the chunk boundaries happened to fall.
 */
/**
 * Every two-cut split of each shape, rather than a sample of random ones.
 *
 * Random chunking is the wrong instrument for this: the leak it is looking for lives
 * at specific boundaries, so a run that misses them passes, and the same test fails
 * on the next run with no code change. Every split is only a few thousand cases per
 * shape and it is deterministic, so a failure names the boundary that broke.
 *
 * It has already earned its keep. The fenced case leaked its closing ``` on 2725 of
 * 3160 splits because the wait branch of #takeUntagged stripped the opening fence
 * without recording that the closing half was still to come - a defect the random
 * version of this test reported as a single unreproducible failure.
 */
function everySplit(src, check) {
  for (let i = 1; i < src.length; i++) {
    for (let j = i + 1; j < src.length; j++) {
      const scanner = new ToolCallScanner(null, TOOLS);
      let text = '';
      const calls = [];
      for (const part of [src.slice(0, i), src.slice(i, j), src.slice(j)]) {
        const out = scanner.push(part);
        text += out.text;
        calls.push(...out.calls);
      }
      const rest = scanner.flush();
      text += rest.text;
      calls.push(...rest.calls);
      check(text, calls, `cut ${i},${j} of ${JSON.stringify(src)}`);
    }
  }
}

/** Anything here reaching the chat is markup the user was never meant to see. */
const LEAK = /<\s*\/?\s*(?:tool[_\- ]?call|tool[_\- ]?use|function[_\- ]?call)|"arguments"\s*:|```/i;

test('no chunking of a call leaks any of it into the chat', () => {
  const BODY = '{"name": "write_file", "arguments": {"path": "a.js", "content": "let x = {a: 1};"}}';
  const cases = [
    ['canonical tagged', `<tool_call>${BARE}</tool_call>`, 1],
    ['hyphenated tag', `<tool-call>${BARE}</tool-call>`, 1],
    ['capitalised tag', `<Tool_Call>${BARE}</Tool_Call>`, 1],
    ['spaced tag', `< tool_call >${BARE}</ tool_call >`, 1],
    ['tool_use tag', `<tool_use>${BARE}</tool_use>`, 1],
    ['function_call tag', `<function_call>${BARE}</function_call>`, 1],
    ['json fence', `Now:\n\`\`\`json\n${BARE}\n\`\`\`\nDone.`, 1],
    ['bare fence', `Now:\n\`\`\`\n${BARE}\n\`\`\`\n`, 1],
    ['untagged, mid-reply', `I will read it.\n${BARE}\nNext.`, 1],
    ['prose around a tagged call', `Let me look.\n<tool_call>${BARE}</tool_call>\nThat is it.`, 1],
    ['two calls', `<tool_call>${BARE}</tool_call>\n<tool_call>${BODY}</tool_call>`, 2],
    ['braces inside the arguments', `<tool_call>${BODY}</tool_call>`, 1],
    ['a tagged call inside a fence', `\`\`\`\n<tool_call>${BARE}</tool_call>\n\`\`\`\n`, 1],
    ['mangled closing tag', `<tool_call>${BARE}</tool_call}`, 1],
    ['no closing tag at all', `<tool_call>${BARE}`, 1],
  ];

  for (const [label, src, want] of cases) {
    everySplit(src, (text, calls, where) => {
      assert.strictEqual(calls.length, want, `${label}: ${where} :: chat=${text}`);
      assert.doesNotMatch(text, LEAK, `${label}: ${where}`);
    });
  }
});

/**
 * The other half of the same bargain. Recognising more shapes as calls is only safe
 * if prose that merely looks like one still arrives untouched - and an answer *about*
 * tool calls is the likeliest thing a user asks for while debugging this plugin.
 */
test('no chunking turns prose into a tool call, or alters a character of it', () => {
  const cases = [
    'No tools needed. Here is a { and a < and a fence:\n```\nx = 1\n```\nend.',
    // JSON with words either side of it is the model TALKING about a call. Treating
    // it as one gutted the sentence and ran a tool nobody asked for.
    `I think ${BARE} should do it.`,
    `The package.json contains {"name": "read_file"} which is confusing but not a call.`,
    `A tool call looks like ${BARE} in this protocol.`,
    'A tool call looks like {"name": "some_tool", "arguments": {}} in general.',
    'Your config:\n```json\n{"compilerOptions": {"strict": true}}\n```\nThat is all.',
    'The bug is on line 42 of app.js. Fix the off-by-one and you are done.',
  ];
  for (const src of cases) {
    everySplit(src, (text, calls, where) => {
      assert.strictEqual(calls.length, 0, `${where} :: became ${calls.length} call(s)`);
      assert.strictEqual(text, src, where);
    });
  }
});

test('prose is never held hostage by a brace it happens to contain', () => {
  const prose = 'No tools needed. Here is a { and a < and a fence:\n```\nx = 1\n```\nend.';
  for (let trial = 0; trial < 200; trial++) {
    const scanner = new ToolCallScanner(null, TOOLS);
    let text = '';
    for (let i = 0; i < prose.length;) {
      const n = 1 + Math.floor(Math.random() * 9);
      text += scanner.push(prose.slice(i, i + n)).text;
      i += n;
    }
    text += scanner.flush().text;
    assert.strictEqual(text, prose);
  }
});
