const vscode = require('vscode');

const TOKEN_KEY = 'ellm.authToken';
const COOKIE_KEY = 'ellm.cookie';

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

async function getSecret(context, key) {
  const mode = tokenStorageMode(context);

  if (mode === 'keychain') {
    try {
      const secret = await context.secrets.get(key);
      if (secret) return secret;
    } catch {
      // Keychain unavailable - fall through to the plain stores.
    }
  }
  // Always consult both plain stores, so switching modes never strands a value.
  return context.workspaceState.get(key) ?? context.globalState.get(key);
}

/** Returns a warning string if the requested store could not be used, else null. */
async function setSecret(context, key, value) {
  const mode = tokenStorageMode(context);
  await clearSecret(context, key);

  if (mode === 'keychain') {
    try {
      await context.secrets.store(key, value);
      return null;
    } catch (err) {
      await context.globalState.update(key, value);
      return `the OS keychain was unavailable (${err.message}), so the value was stored `
        + 'unencrypted in VS Code global storage instead.';
    }
  }

  if (mode === 'workspace') await context.workspaceState.update(key, value);
  else await context.globalState.update(key, value);
  return null;
}

async function clearSecret(context, key) {
  try {
    await context.secrets.delete(key);
  } catch {
    // Nothing to clear if the keychain is not reachable.
  }
  await context.globalState.update(key, undefined);
  await context.workspaceState.update(key, undefined);
}

const getToken = (context) => getSecret(context, TOKEN_KEY);
const setToken = (context, token) => setSecret(context, TOKEN_KEY, token);
const clearToken = (context) => clearSecret(context, TOKEN_KEY);

const getCookie = (context) => getSecret(context, COOKIE_KEY);
const setCookie = (context, cookie) => setSecret(context, COOKIE_KEY, cookie);

/**
 * Values that are private but not credentials - the identity block the backend
 * wants, which carries a name, an email and an employee id. Kept in the
 * extension's own storage and deliberately never written to settings.json, which
 * is a file people paste into issues and sync between machines.
 */
function getPrivate(context, key, fallback) {
  return context.globalState.get(`private.${key}`) ?? fallback;
}

async function setPrivate(context, key, value) {
  await context.globalState.update(`private.${key}`, value);
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
  TOKEN_KEY, COOKIE_KEY, getToken, setToken, clearToken, tokenLocation,
  getSecret, setSecret, clearSecret, getCookie, setCookie,
  getPrivate, setPrivate, readSetting, saveSettings, tokenStorageMode,
};
