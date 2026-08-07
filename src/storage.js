const vscode = require('vscode');

const TOKEN_KEY = 'ellm.authToken';

/**
 * Where the auth token lives.
 *
 * `SecretStorage` (the OS keychain) is the safe default, but it is not always
 * reachable - locked-down corporate machines can refuse it, and a token that
 * silently fails to save is worse than one stored plainly. So storage is
 * selectable, and the keychain is opt-in rather than assumed.
 *
 *   global    - VS Code global storage, this machine, all folders (default)
 *   workspace - VS Code workspace storage, this folder only
 *   keychain  - OS keychain via SecretStorage
 *
 * Only `keychain` encrypts. The other two are plain values on disk inside VS
 * Code's own storage - not in your repository, but not protected either.
 */
function tokenStorageMode(context) {
  return readSetting(context, 'tokenStorage', 'global');
}

async function getToken(context) {
  const mode = tokenStorageMode(context);

  if (mode === 'keychain') {
    try {
      const secret = await context.secrets.get(TOKEN_KEY);
      if (secret) return secret;
    } catch {
      // Keychain unavailable - fall through to the plain stores.
    }
  }
  // Always consult both plain stores, so switching modes never strands a token.
  return context.workspaceState.get(TOKEN_KEY) ?? context.globalState.get(TOKEN_KEY);
}

/** Returns a warning string if the requested store could not be used, else null. */
async function setToken(context, token) {
  const mode = tokenStorageMode(context);
  await clearToken(context);

  if (mode === 'keychain') {
    try {
      await context.secrets.store(TOKEN_KEY, token);
      return null;
    } catch (err) {
      await context.globalState.update(TOKEN_KEY, token);
      return `the OS keychain was unavailable (${err.message}), so the token was stored `
        + 'unencrypted in VS Code global storage instead.';
    }
  }

  if (mode === 'workspace') await context.workspaceState.update(TOKEN_KEY, token);
  else await context.globalState.update(TOKEN_KEY, token);
  return null;
}

async function clearToken(context) {
  try {
    await context.secrets.delete(TOKEN_KEY);
  } catch {
    // Nothing to clear if the keychain is not reachable.
  }
  await context.globalState.update(TOKEN_KEY, undefined);
  await context.workspaceState.update(TOKEN_KEY, undefined);
}

/** Human-readable description of where the token currently is. */
async function tokenLocation(context) {
  try {
    if (await context.secrets.get(TOKEN_KEY)) return 'OS keychain';
  } catch { /* unreachable keychain */ }
  if (context.workspaceState.get(TOKEN_KEY) !== undefined) return 'workspace storage (this folder, unencrypted)';
  if (context.globalState.get(TOKEN_KEY) !== undefined) return 'global storage (this machine, unencrypted)';
  return null;
}

/**
 * Settings value, preferring the fallback written when settings.json was unwritable.
 * A malformed user settings.json is common and unrelated to this extension, but it
 * would otherwise make the extension impossible to configure.
 */
function readSetting(context, key, fallbackDefault) {
  const stored = context.globalState.get(`fallback.${key}`);
  if (stored !== undefined) return stored;
  return vscode.workspace.getConfiguration('ellm').get(key, fallbackDefault);
}

/** Writes settings, tolerating a settings.json VS Code refuses to touch. */
async function saveSettings(context, values) {
  const cfg = vscode.workspace.getConfiguration('ellm');
  let failure = null;

  for (const [key, value] of Object.entries(values)) {
    try {
      await cfg.update(key, value, vscode.ConfigurationTarget.Global);
      await context.globalState.update(`fallback.${key}`, undefined);
    } catch (err) {
      await context.globalState.update(`fallback.${key}`, value);
      failure = err.message;
    }
  }

  return failure
    ? 'your settings.json could not be written, so these values were saved inside the '
      + `extension instead. Everything works. (${failure})`
    : null;
}

module.exports = {
  TOKEN_KEY, getToken, setToken, clearToken, tokenLocation, readSetting, saveSettings, tokenStorageMode,
};
