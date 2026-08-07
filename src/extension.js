const vscode = require('vscode');
const { EllmChatProvider, SECRET_KEY } = require('./provider');
const { openConfigPanel } = require('./configPanel');

let output;

async function activate(context) {
  output = vscode.window.createOutputChannel('Enterprise LLM');
  context.subscriptions.push(output);
  output.appendLine('Enterprise LLM provider activating…');

  // Test wiring: lets an automated run configure the extension without the UI.
  // Deliberately ignored in a normal install - otherwise anything able to set
  // environment variables for VS Code could silently repoint the extension at
  // another endpoint and plant a token in the keychain.
  const underTest = context.extensionMode === vscode.ExtensionMode.Test
    || context.extensionMode === vscode.ExtensionMode.Development;
  if (underTest && process.env.ELLM_TEST_URL && process.env.ELLM_TEST_TOKEN) {
    await vscode.workspace.getConfiguration('ellm')
      .update('url', process.env.ELLM_TEST_URL, vscode.ConfigurationTarget.Global);
    await context.secrets.store(SECRET_KEY, process.env.ELLM_TEST_TOKEN);
    output.appendLine(`seeded connection from env: ${process.env.ELLM_TEST_URL}`);
  }

  const provider = new EllmChatProvider(context, output);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('corp-ellm', provider));
  output.appendLine('registered language model provider "corp-ellm"');

  context.subscriptions.push(
    vscode.commands.registerCommand('ellm.configure', () => openConfigPanel(context, provider)),
    vscode.commands.registerCommand('ellm.signOut', async () => {
      await context.secrets.delete(SECRET_KEY);
      provider.refresh();
      vscode.window.showInformationMessage('Enterprise LLM token cleared.');
    }),
    vscode.commands.registerCommand('ellm.selfTest', () => runSelfTest(output)),
  );

  return { provider };
}

/**
 * Exercises the real vscode.lm path end to end: model discovery, a short answer,
 * an answer longer than the upstream cap (proving continuation), and a tool call.
 */
async function runSelfTest(out) {
  out.show(true);
  const results = [];
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    out.appendLine(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'corp-ellm' });
    check('provider exposes models to vscode.lm', models.length > 0, `${models.length} model(s)`);
    if (!models.length) return finish(out, results);

    const model = models[0];
    check('model advertises tool calling', model.capabilities?.toolCalling !== false, model.id);

    const cts = new vscode.CancellationTokenSource();
    const ask = async (prompt, options = {}) => {
      const res = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        options,
        cts.token,
      );
      let text = '';
      const calls = [];
      for await (const part of res.stream) {
        if (part instanceof vscode.LanguageModelTextPart) text += part.value;
        else if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part);
      }
      return { text, calls };
    };

    const short = await ask('Reply with exactly: PROVIDER ONLINE');
    check('short round trip returns text', short.text.trim().length > 0, JSON.stringify(short.text.slice(0, 60)));

    const long = await ask(
      'Output exactly 200 numbered lines. Format each line as: NNN | followed by 40 letters. '
      + 'No preamble, no commentary, no code fence. Just the 200 lines.',
    );
    check('long answer exceeds the 5000-char upstream cap', long.text.length > 5000, `${long.text.length} chars`);
    check('no continuation preamble leaked', !/\b(sure|continuing)\b[^\n]{0,40}:/i.test(long.text));
    const lines = long.text.split('\n').filter((l) => /^\s*\d{1,3}\s*\|/.test(l));
    const unique = new Set(lines.map((l) => l.trim().split('|')[0].trim()));
    check('no duplicated line numbers across the seam', unique.size === lines.length,
      `${lines.length} lines, ${unique.size} unique`);

    const tooled = await ask('What is the weather in Bangalore? Use the tool.', {
      tools: [{
        name: 'get_weather',
        description: 'Get the current weather for a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
    });
    check('tool call surfaced as LanguageModelToolCallPart', tooled.calls.length > 0, `${tooled.calls.length} call(s)`);
    if (tooled.calls.length) {
      check('tool name and input intact', tooled.calls[0].name === 'get_weather' && Boolean(tooled.calls[0].input),
        `${tooled.calls[0].name} ${JSON.stringify(tooled.calls[0].input)}`);
    }
    check('no raw tool tag leaked into text', !/<tool_call>/.test(tooled.text));
  } catch (err) {
    check('self test ran without throwing', false, err.message);
  }

  return finish(out, results);
}

function finish(out, results) {
  const failed = results.filter((r) => !r.pass).length;
  out.appendLine(`\n${results.length - failed}/${results.length} passed`);
  const msg = `Enterprise LLM self test: ${results.length - failed}/${results.length} passed`;
  if (failed) vscode.window.showWarningMessage(msg);
  else vscode.window.showInformationMessage(msg);
  return results;
}

function deactivate() {}

module.exports = { activate, deactivate };
