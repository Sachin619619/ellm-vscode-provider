const vscode = require('vscode');
const { CorpClient } = require('./corpClient');
const { SECRET_KEY } = require('./provider');

/** Webview where the auth token and endpoint are entered. Token goes to SecretStorage. */
function openConfigPanel(context, provider) {
  const panel = vscode.window.createWebviewPanel(
    'ellmConfig',
    'Enterprise LLM: Connection',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const cfg = () => vscode.workspace.getConfiguration('ellm');
  panel.webview.html = html(panel.webview);

  const pushState = async () => {
    const token = await context.secrets.get(SECRET_KEY);
    panel.webview.postMessage({
      type: 'state',
      url: cfg().get('url', ''),
      hasToken: Boolean(token),
      maxResponseChars: cfg().get('maxResponseChars', 5000),
      maxContinuations: cfg().get('maxContinuations', 8),
    });
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'ready') return pushState();

      if (msg.type === 'clear') {
        await context.secrets.delete(SECRET_KEY);
        provider.refresh();
        await pushState();
        return panel.webview.postMessage({ type: 'result', ok: true, message: 'Saved token cleared.' });
      }

      if (msg.type === 'save') {
        const url = String(msg.url || '').trim().replace(/\/+$/, '');
        if (!url) throw new Error('Enter the enterprise LLM URL.');

        await cfg().update('url', url, vscode.ConfigurationTarget.Global);
        await cfg().update('maxResponseChars', Number(msg.maxResponseChars) || 5000, vscode.ConfigurationTarget.Global);
        await cfg().update('maxContinuations', Number(msg.maxContinuations) || 8, vscode.ConfigurationTarget.Global);
        if (msg.token) await context.secrets.set(SECRET_KEY, String(msg.token));

        const token = await context.secrets.get(SECRET_KEY);
        if (!token) throw new Error('Enter the auth token.');

        const info = await new CorpClient({ url, token }).listModels();
        provider.refresh();
        await pushState();

        const names = info.models.map((m) => `${m.alias} (${m.label})`).join(', ');
        panel.webview.postMessage({
          type: 'result',
          ok: true,
          message: `Connected. ${info.models.length} model(s): ${names}. Upstream cap ${info.limits?.maxResponseChars ?? '?'} chars.`,
        });
        vscode.window.showInformationMessage('Enterprise LLM connected — pick it in the chat model picker.');
      }
    } catch (err) {
      panel.webview.postMessage({ type: 'result', ok: false, message: err.message });
    }
  });

  return panel;
}

function nonce() {
  return require('crypto').randomBytes(16).toString('base64');
}

function html(webview) {
  const n = nonce();
  // Locked down: no remote loads of any kind, and only this one inline script
  // may run. The panel handles an auth token, so it gets no latitude.
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; `
    + `script-src 'nonce-${n}'; img-src ${webview.cspSource} data:;`;

  return /* html */ `<!doctype html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 22px 26px; max-width: 620px; }
  h2 { margin: 0 0 4px; font-size: 17px; }
  p.sub { margin: 0 0 22px; color: var(--vscode-descriptionForeground); font-size: 12.5px; }
  label { display: block; margin: 16px 0 5px; font-size: 12px; font-weight: 600; }
  .hint { font-weight: 400; color: var(--vscode-descriptionForeground); }
  input { width: 100%; padding: 7px 9px; font-family: inherit; font-size: 13px;
          color: var(--vscode-input-foreground); background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .actions { margin-top: 24px; display: flex; gap: 10px; align-items: center; }
  button { padding: 7px 15px; font-size: 13px; border: none; border-radius: 3px; cursor: pointer;
           color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground);
                     background: var(--vscode-button-secondaryBackground); }
  #status { margin-top: 20px; padding: 11px 13px; border-radius: 4px; font-size: 12.5px;
            display: none; white-space: pre-wrap; }
  #status.ok { display: block; background: var(--vscode-inputValidation-infoBackground);
               border: 1px solid var(--vscode-inputValidation-infoBorder); }
  #status.err { display: block; background: var(--vscode-inputValidation-errorBackground);
                border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .saved { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 5px; }
</style></head><body>
  <h2>Enterprise LLM</h2>
  <p class="sub">Point VS Code chat at your company's chat-only LLM. The token is kept in the OS keychain, never in settings.json.</p>

  <label>Endpoint URL <span class="hint">— base URL, no path</span></label>
  <input id="url" placeholder="http://127.0.0.1:9800" />

  <label>Auth token <span class="hint">— sent as the X-Corp-Auth header</span></label>
  <input id="token" type="password" placeholder="paste token" />
  <div class="saved" id="saved"></div>

  <div class="grid">
    <div>
      <label>Response char cap</label>
      <input id="maxResponseChars" type="number" min="0" />
    </div>
    <div>
      <label>Max continuations</label>
      <input id="maxContinuations" type="number" min="0" />
    </div>
  </div>

  <div class="actions">
    <button id="save">Save &amp; Test</button>
    <button id="clear" class="secondary">Clear token</button>
  </div>

  <div id="status"></div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      $('url').value = m.url || '';
      $('maxResponseChars').value = m.maxResponseChars;
      $('maxContinuations').value = m.maxContinuations;
      $('saved').textContent = m.hasToken ? 'A token is saved in the keychain. Leave blank to keep it.' : 'No token saved yet.';
    }
    if (m.type === 'result') {
      const s = $('status');
      s.className = m.ok ? 'ok' : 'err';
      s.textContent = m.message;
    }
  });

  $('save').onclick = () => {
    $('status').className = 'ok';
    $('status').textContent = 'Testing connection…';
    vscode.postMessage({
      type: 'save',
      url: $('url').value,
      token: $('token').value,
      maxResponseChars: $('maxResponseChars').value,
      maxContinuations: $('maxContinuations').value,
    });
    $('token').value = '';
  };
  $('clear').onclick = () => vscode.postMessage({ type: 'clear' });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

module.exports = { openConfigPanel };
