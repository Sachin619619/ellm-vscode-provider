/**
 * Runs inside a real VS Code instance. Exercises the genuine vscode.lm path -
 * the same path Copilot chat and agent mode use - against the live enterprise LLM.
 */
const vscode = require('vscode');
const fs = require('fs');
const storage = require('../../src/storage');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function collect(model, messages, options, cts) {
  const res = await model.sendRequest(messages, options, cts.token);
  let text = '';
  const calls = [];
  for await (const part of res.stream) {
    if (part instanceof vscode.LanguageModelTextPart) text += part.value;
    else if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part);
  }
  return { text, calls };
}

async function run() {
  const started = Date.now();
  try {
    // --- workspace ---------------------------------------------------------
    const folders = vscode.workspace.workspaceFolders ?? [];
    const expected = process.env.ELLM_TEST_WORKSPACE;
    check('a workspace folder is open', folders.length > 0,
      folders.map((f) => f.uri.fsPath).join(', ') || 'no folder');
    if (expected) {
      check('the requested workspace is the open one',
        folders.some((f) => f.uri.fsPath === expected), expected);
    }

    // --- extension activation ---------------------------------------------
    const ext = vscode.extensions.getExtension('sachin.ellm-provider');
    check('extension is present', Boolean(ext));
    if (ext && !ext.isActive) await ext.activate();
    check('extension activated', Boolean(ext?.isActive));

    // --- model discovery through the real API ------------------------------
    // activate() seeds the connection from ELLM_TEST_* when it is running under
    // test, so the throwaway --user-data-dir profile arrives configured. Note the
    // model list is part of that seed and not optional: there is no discovery
    // endpoint, so an unset ELLM_TEST_MODELS means zero models and the run stops
    // here having tested none of what it exists to test.
    let models = [];
    for (let i = 0; i < 20 && models.length === 0; i++) {
      models = await vscode.lm.selectChatModels({ vendor: 'corp-ellm' });
      if (!models.length) await new Promise((r) => setTimeout(r, 500));
    }
    check('vscode.lm.selectChatModels finds the enterprise models', models.length > 0,
      models.map((m) => m.id).join(', ') || 'none');
    if (!models.length) return report(started);

    const model = models[0];
    check('model is usable by agents (toolCalling)', model.capabilities?.toolCalling !== false, String(model.id));
    // The consumer-side LanguageModelChat exposes maxInputTokens only; the output
    // budget we declare lives on the provider side.
    check('model reports a usable input budget', (model.maxInputTokens ?? 0) > 5000,
      `${model.maxInputTokens} tokens`);

    const cts = new vscode.CancellationTokenSource();

    // --- 1. short round trip ----------------------------------------------
    const short = await collect(model, [vscode.LanguageModelChatMessage.User('Reply with exactly: PROVIDER ONLINE')], {}, cts);
    check('short request returns text', short.text.trim().length > 0, JSON.stringify(short.text.slice(0, 70)));

    // --- 2. beat the 5000-char cap ----------------------------------------
    const long = await collect(model, [vscode.LanguageModelChatMessage.User(
      'Output exactly 200 numbered lines. Format each line as: NNN | followed by 40 letters. '
      + 'No preamble, no commentary, no code fence. Just the 200 lines.',
    )], {}, cts);

    check('answer is longer than the 5000-char upstream cap', long.text.length > 5000, `${long.text.length} chars`);
    check('no continuation preamble leaked', !/\b(sure|certainly|continuing)\b[^\n]{0,40}:/i.test(long.text));
    const numbered = long.text.split('\n').filter((l) => /^\s*\d{1,3}\s*\|/.test(l));
    const unique = new Set(numbered.map((l) => l.trim().split('|')[0].trim()));
    check('no duplicated lines across the continuation seam', unique.size === numbered.length,
      `${numbered.length} lines, ${unique.size} unique`);

    // --- 3. tool calling (what agent mode depends on) ----------------------
    const readFile = {
      name: 'read_file',
      description: 'Read a file from the open repository',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    };
    // Whether a model chooses to call a tool is probabilistic, so allow a couple of
    // attempts before calling it a failure - the plumbing is what is under test.
    let tooled = { text: '', calls: [] };
    for (let attempt = 1; attempt <= 3 && tooled.calls.length === 0; attempt++) {
      tooled = await collect(model, [vscode.LanguageModelChatMessage.User(
        'Read the file package.json in this repo. You MUST call the read_file tool to do it. '
        + 'Emit the tool call and nothing else. Do not answer from memory.',
      )], { tools: [readFile] }, cts);
      console.log(`  tool attempt ${attempt}: ${tooled.calls.length} call(s), text=${JSON.stringify(tooled.text.slice(0, 160))}`);
    }

    check('tool call arrives as LanguageModelToolCallPart', tooled.calls.length > 0,
      `${tooled.calls.length} call(s); text=${JSON.stringify(tooled.text.slice(0, 120))}`);
    if (tooled.calls.length) {
      check('tool name intact', tooled.calls[0].name === 'read_file', tooled.calls[0].name);
      check('tool input is a parsed object', tooled.calls[0].input && typeof tooled.calls[0].input === 'object',
        JSON.stringify(tooled.calls[0].input));
    }
    check('no raw tool tag leaked into visible text', !/<tool_call>/.test(tooled.text));

    // --- 4. full agent round trip: tool result fed back --------------------
    if (tooled.calls.length) {
      const call = tooled.calls[0];
      const pkgPath = `${folders[0].uri.fsPath}/package.json`;
      let fileText = '{}';
      try {
        fileText = fs.readFileSync(pkgPath, 'utf8').slice(0, 1200);
      } catch { /* repo may not have one at the root */ }

      const followUp = await collect(model, [
        vscode.LanguageModelChatMessage.User('Read the file package.json in this repo. Use the read_file tool.'),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(fileText)]),
        ]),
      ], { tools: [readFile] }, cts);

      check('model answers from the tool result', followUp.text.trim().length > 0,
        JSON.stringify(followUp.text.slice(0, 120)));
      // Models close the tag badly ("</tool_call}") often enough that this leaked
      // raw markup into agent answers before the scanner learned to salvage it.
      check('no raw tool tag leaks into the answer after a tool result',
        !/<\/?\s*tool_call/i.test(followUp.text), JSON.stringify(followUp.text.slice(0, 120)));
    }

    // --- 5. token storage without the OS keychain --------------------------
    const context = ext?.exports?.context;
    check('extension exposes its context under test', Boolean(context));
    if (context) await checkStorage(context);
  } catch (err) {
    check('suite ran without throwing', false, `${err.message}\n${err.stack ?? ''}`);
  }

  return report(started);
}

/**
 * A managed machine can refuse SecretStorage outright, so the token has to land
 * somewhere plain and still be readable — and a settings.json the extension cannot
 * write must not take the whole save down with it. Run against the real
 * ExtensionContext rather than a stub, since that is where the refusals happen.
 */
async function checkStorage(context) {
  const cfg = () => vscode.workspace.getConfiguration('ellm');
  const originalMode = cfg().get('tokenStorage', 'global');
  const originalToken = await storage.getToken(context);
  const probe = `probe-token-${Date.now()}`;

  const inKeychain = async () => {
    try {
      return await context.secrets.get(storage.TOKEN_KEY);
    } catch {
      return undefined; // keychain refused — exactly the case this all exists for
    }
  };

  try {
    await cfg().update('tokenStorage', 'global', vscode.ConfigurationTarget.Global);
    await storage.setToken(context, probe);
    check('token round trips in the default (non-keychain) store',
      (await storage.getToken(context)) === probe);
    check('default store never touches SecretStorage', (await inKeychain()) === undefined);
    check('default store is VS Code global storage',
      context.globalState.get(storage.TOKEN_KEY) === probe);
    check('the panel can say where the token lives',
      (await storage.tokenLocation(context)) === 'global storage (this machine, unencrypted)',
      String(await storage.tokenLocation(context)));

    await cfg().update('tokenStorage', 'workspace', vscode.ConfigurationTarget.Global);
    await storage.setToken(context, `${probe}-ws`);
    check('workspace mode writes to workspace storage',
      context.workspaceState.get(storage.TOKEN_KEY) === `${probe}-ws`);
    check('changing mode leaves no copy in the old store',
      context.globalState.get(storage.TOKEN_KEY) === undefined);
    check('getToken finds the token in either plain store',
      (await storage.getToken(context)) === `${probe}-ws`);

    // No literal default here: the manifest's is the only one, and writing 8 in
    // this assertion is how the panel came to disagree with the schema in the
    // first place. Ask storage for it the same way the code does.
    const schemaDefault = storage.defaultFor('maxContinuations');
    await context.globalState.update('fallback.maxContinuations', 3);
    check('an unwritable settings.json falls back to extension storage',
      storage.readSetting(context, 'maxContinuations') === 3);
    await context.globalState.update('fallback.maxContinuations', undefined);
    check('clearing the fallback hands the setting back to settings.json',
      storage.readSetting(context, 'maxContinuations') === schemaDefault,
      `expected the manifest default ${schemaDefault}`);

    await storage.clearToken(context);
    check('clearing the token empties every store',
      (await storage.getToken(context)) === undefined && (await storage.tokenLocation(context)) === null);
  } finally {
    await cfg().update('tokenStorage', originalMode, vscode.ConfigurationTarget.Global);
    if (originalToken) await storage.setToken(context, originalToken);
  }
}

function report(started) {
  const failed = results.filter((r) => !r.pass).length;
  const summary = { passed: results.length - failed, total: results.length, ms: Date.now() - started, results };
  console.log(`\n${summary.passed}/${summary.total} passed in ${summary.ms}ms`);
  try {
    fs.writeFileSync(process.env.ELLM_RESULT_FILE || '/tmp/ellm-e2e.json', JSON.stringify(summary, null, 2));
  } catch { /* best effort */ }
  if (failed) throw new Error(`${failed} check(s) failed`);
}

module.exports = { run };
