/**
 * Launches the real installed VS Code with the actionbot repo open and runs the
 * E2E suite inside it. Reuses the local VS Code build rather than downloading one,
 * so the test runs against exactly the editor being used day to day.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
  // Any repo works as the test workspace; defaults to this one.
  const workspace = process.env.ELLM_TEST_WORKSPACE || extensionDevelopmentPath;

  // Reuse a locally installed VS Code when there is one, otherwise let
  // @vscode/test-electron download a build.
  const localVSCode = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
  const vscodeExecutablePath = fs.existsSync(localVSCode) ? localVSCode : undefined;

  // The suite writes settings and stashes tokens. Point VS Code at a throwaway
  // profile so a test run never edits the real settings.json or leaves a probe
  // token behind in the everyday globalState.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ellm-e2e-'));

  try {
    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-extensions keeps the installed copy of this extension from
      // fighting the one under test over the same provider vendor id.
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-gpu',
        '--user-data-dir', userDataDir,
      ],
      // activate() seeds the connection from these when it is running under test.
      // All of them have to be forwarded, not just the URL and token: the profile
      // is a fresh --user-data-dir with nothing configured, and the model list in
      // particular is not discoverable - the backend has no models endpoint the
      // provider can ask, so an unset ELLM_TEST_MODELS leaves the picker empty and
      // the suite stops at model discovery. That is what it did.
      extensionTestsEnv: {
        ELLM_TEST_URL: process.env.ELLM_TEST_URL,
        ELLM_TEST_TOKEN: process.env.ELLM_TEST_TOKEN,
        ELLM_TEST_MODELS: process.env.ELLM_TEST_MODELS,
        ELLM_TEST_CHAT_PATH: process.env.ELLM_TEST_CHAT_PATH,
        ELLM_TEST_PROMPT_FIELD: process.env.ELLM_TEST_PROMPT_FIELD,
        ELLM_TEST_AUTH_HEADER: process.env.ELLM_TEST_AUTH_HEADER,
        ELLM_TEST_MESSAGES_FIELD: process.env.ELLM_TEST_MESSAGES_FIELD,
        ELLM_TEST_MESSAGES_FORMAT: process.env.ELLM_TEST_MESSAGES_FORMAT,
        ELLM_TEST_WORKSPACE: workspace,
        ELLM_RESULT_FILE: process.env.ELLM_RESULT_FILE,
      },
    });
    console.log('E2E suite passed');
  } catch (err) {
    console.error('E2E suite failed:', err.message);
    process.exitCode = 1; // not process.exit, so the temp profile below is cleaned up
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main();
