/**
 * Launches the real installed VS Code with the actionbot repo open and runs the
 * E2E suite inside it. Reuses the local VS Code build rather than downloading one,
 * so the test runs against exactly the editor being used day to day.
 */
const path = require('path');
const fs = require('fs');
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

  try {
    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-extensions keeps the installed copy of this extension from
      // fighting the one under test over the same provider vendor id.
      launchArgs: [workspace, '--disable-extensions', '--disable-gpu'],
      extensionTestsEnv: {
        ELLM_TEST_URL: process.env.ELLM_TEST_URL,
        ELLM_TEST_TOKEN: process.env.ELLM_TEST_TOKEN,
        ELLM_RESULT_FILE: process.env.ELLM_RESULT_FILE,
      },
    });
    console.log('E2E suite passed');
  } catch (err) {
    console.error('E2E suite failed:', err.message);
    process.exit(1);
  }
}

main();
