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
      extensionTestsEnv: {
        ELLM_TEST_URL: process.env.ELLM_TEST_URL,
        ELLM_TEST_TOKEN: process.env.ELLM_TEST_TOKEN,
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
