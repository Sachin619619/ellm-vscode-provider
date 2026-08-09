const vscode = require('vscode');
const { CorpClient, describeConflict, describeRequest } = require('./corpClient');
const {
  getToken, setToken, clearToken, tokenLocation, getCookie, setCookie,
  getPrivate, setPrivate, readSetting, saveSettings, COOKIE_KEY, clearSecret,
} = require('./storage');

/**
 * Webview where the connection is entered. Everything the backend needs that is
 * specific to a person or a company - credentials, the identity block, the model
 * name - is typed here rather than living in the source, so the code stays plain
 * and the confidential parts never leave this machine. See storage.js for where
 * each piece lands.
 */
function openConfigPanel(context, provider) {
  const panel = vscode.window.createWebviewPanel(
    'ellmConfig',
    'Enterprise LLM',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = html(panel.webview);

  const pushState = async () => {
    panel.webview.postMessage({
      type: 'state',
      url: readSetting(context, 'url', ''),
      chatPath: readSetting(context, 'chatPath', '/chat'),
      promptField: readSetting(context, 'promptField', 'prompt'),
      modelField: readSetting(context, 'modelField', 'model'),
      tokenLocation: await tokenLocation(context),
      hasCookie: Boolean(await getCookie(context)),
      authHeader: readSetting(context, 'authHeader', 'X-Corp-Auth'),
      authPrefix: readSetting(context, 'authPrefix', ''),
      models: readSetting(context, 'models', ''),
      textPath: readSetting(context, 'textPath', ''),
      identity: JSON.stringify(getPrivate(context, 'identity', {}), null, 2),
      params: JSON.stringify(getPrivate(context, 'params', {}), null, 2),
      maxResponseChars: readSetting(context, 'maxResponseChars', 5000),
      maxContinuations: readSetting(context, 'maxContinuations', 8),
    });
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg.type === 'ready') return pushState();

      if (msg.type === 'clear') {
        await clearToken(context);
        await clearSecret(context, COOKIE_KEY);
        provider.refresh();
        await pushState();
        return panel.webview.postMessage({
          type: 'result', ok: true, message: 'Saved token and cookie cleared.',
        });
      }

      if (msg.type === 'save') {
        const url = String(msg.url || '').trim().replace(/\/+$/, '');
        if (!url) throw new Error('Enter the enterprise LLM URL.');

        // Credentials first: they are the part you cannot easily re-enter, and they
        // must not be lost to an unrelated settings.json problem.
        const warnings = [];
        if (msg.token) warnings.push(await setToken(context, String(msg.token)));
        if (msg.cookie) warnings.push(await setCookie(context, String(msg.cookie)));

        const identity = parseJson(msg.identity, 'Extra request fields');
        const params = parseJson(msg.params, 'Model parameters');
        await setPrivate(context, 'identity', identity);
        await setPrivate(context, 'params', params);

        const authHeader = String(msg.authHeader || '').trim() || 'X-Corp-Auth';
        const authPrefix = String(msg.authPrefix ?? '');
        const chatPath = String(msg.chatPath || '').trim() || '/chat';
        const models = String(msg.models || '').trim();
        const promptField = String(msg.promptField || '').trim() || 'prompt';
        const modelField = String(msg.modelField || '').trim() || 'model';
        const textPath = String(msg.textPath || '').trim();

        warnings.push(await saveSettings(context, {
          url,
          chatPath,
          promptField,
          modelField,
          authHeader,
          authPrefix,
          models,
          textPath,
          maxResponseChars: Number(msg.maxResponseChars) || 5000,
          maxContinuations: Number(msg.maxContinuations) || 8,
        }));

        const token = await getToken(context);
        if (!token) throw new Error('Enter the auth token.');

        const client = new CorpClient({
          url,
          token,
          cookie: await getCookie(context),
          authHeader,
          authPrefix,
          chatPath,
          promptField,
          modelField,
          models: models.split(',').map((s) => s.trim()).filter(Boolean),
          textPath,
          servedModelPath: readSetting(context, 'servedModelPath', ''),
          identity,
          params,
        });

        // There is no discovery endpoint to ping, so the test is a real (tiny)
        // round trip. Anything less would report success on a broken connection.
        const message = await smokeTest(client);
        provider.refresh();
        await pushState();

        panel.webview.postMessage({
          type: 'result',
          ok: true,
          message: message + warnings.filter(Boolean).map((w) => `\n\nNote: ${w}`).join(''),
        });
        vscode.window.showInformationMessage('Enterprise LLM connected — pick it in the chat model picker.');
      }
    } catch (err) {
      panel.webview.postMessage({ type: 'result', ok: false, message: err.message });
    }
  });

  return panel;
}

/** An empty box means "no extra fields", not an error. */
function parseJson(text, label) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object, e.g. {"key": "value"}.`);
  }
  return parsed;
}

/** One short request through the real path, so "Connected" means it. */
async function smokeTest(client) {
  const started = Date.now();
  let text = '';
  let firstFrame = '';
  let servedModel = null;
  let shape = null;
  const problems = [];

  const stream = client.converse({
    modelAlias: client.models[0]?.alias ?? client.models[0] ?? undefined,
    turns: [{ speaker: 'human', utterance: 'Reply with exactly: OK' }],
    onRawFrame: (raw) => { firstFrame = raw; },
    onServedModel: (served) => { servedModel = served; },
    onRequest: (s) => { shape = s; },
    onFrameProblem: (msg) => problems.push(msg),
  });

  for await (const ev of stream) {
    if (ev.type === 'text') text += ev.text;
    if (text.length > 400) break;
  }

  if (!text.trim()) {
    throw new Error(`The endpoint answered but no text came back. First frame: ${firstFrame || '(none)'}`);
  }

  let note = '';
  if (shape) {
    note += `\n\nAsked for "${shape.model}" in body field "${shape.modelField}".`;
    // The exact payload, always - this is the one request whose prompt is a fixed
    // harmless string, so showing it costs nothing and it is the only way to
    // compare against what the web app sends without guessing.
    note += `\n\nWHAT WAS SENT\n${describeRequest({
      url: shape.url,
      body: shape.body,
      headers: shape.headers,
      promptField: client.promptField,
    })}`;
    if (shape.conflicts.length) {
      // The panel is where this belongs: it is the one place that can see both the
      // model list and the pasted extra fields at the same time, which is the only
      // way to notice that two different fields are both choosing a model.
      note += `\n\nMODEL FIELD CONFLICT\n${shape.conflicts
        .map((c) => `- ${describeConflict(c, shape.modelField)}`)
        .join('\n')}`;
    }
  }

  if (servedModel && servedModel.confirmed === false) {
    note += '\n\nSERVED MODEL UNCONFIRMED: the reply never named the model that produced it, so '
      + 'there is no way to tell from here whether the model you picked was the one used. If the '
      + 'backend names it somewhere, set "Served model path" to that key.';
  } else if (servedModel && !servedModel.matches) {
    // A wrong model name still answers, so this is the only place the
    // substitution is visible before it silently shapes every later reply.
    note += `\n\nMODEL MISMATCH: you asked for "${servedModel.requested}" but the reply came `
      + `from "${servedModel.served}". The backend does not recognise that name and used its `
      + 'default instead - fix the model list above.';
  } else if (servedModel) {
    note += `\n\nServed by: ${servedModel.served}`;
  }

  if (problems.length) {
    // The answer came through, so this is not a failure - but a stream that needs
    // repairing on every frame is a text-field or shape problem worth naming here
    // rather than leaving in the output channel.
    note += `\n\n${problems.length} frame(s) needed repairing. First: ${problems[0]}`;
  }

  return `Connected in ${Date.now() - started}ms. The model replied: `
    + `${JSON.stringify(text.trim().slice(0, 80))}${note}`;
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
  h3 { margin: 26px 0 0; font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border);
       padding-top: 16px; }
  label { display: block; margin: 16px 0 5px; font-size: 12px; font-weight: 600; }
  .hint { font-weight: 400; color: var(--vscode-descriptionForeground); }
  input, textarea { width: 100%; padding: 7px 9px; font-size: 13px;
          color: var(--vscode-input-foreground); background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
  input { font-family: inherit; }
  textarea { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
             min-height: 96px; resize: vertical; }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
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
  <p class="sub">Everything specific to you or your company is typed here, never written into the extension's code. Credentials go to VS Code's own storage; the identity block stays in extension storage. Neither is ever put in settings.json.</p>

  <label>Endpoint URL <span class="hint">— origin only, no path</span></label>
  <input id="url" placeholder="https://example.com" />

  <label>Chat path <span class="hint">— the streaming endpoint</span></label>
  <input id="chatPath" placeholder="/api/…/chat" />

  <h3>Credentials</h3>

  <label>Auth token</label>
  <input id="token" type="password" placeholder="paste token" />
  <div class="saved" id="saved"></div>

  <label>Cookie <span class="hint">— optional, only if the gateway needs one</span></label>
  <input id="cookie" type="password" placeholder="name=value; name2=value2" />
  <div class="saved" id="savedCookie"></div>

  <div class="grid">
    <div>
      <label>Auth header <span class="hint">— what the token is sent in</span></label>
      <input id="authHeader" placeholder="X-Corp-Auth" />
    </div>
    <div>
      <label>Token prefix <span class="hint">— e.g. "Bearer " with the space</span></label>
      <input id="authPrefix" placeholder="(none)" />
    </div>
  </div>

  <h3>Request</h3>

  <label>Models <span class="hint">— comma separated, as the backend names them</span></label>
  <input id="models" placeholder="model-name-1, model-name-2" />

  <label>Model field <span class="hint">— body key the picked model is sent in</span></label>
  <input id="modelField" placeholder="model" />
  <div class="saved">Must be the key your backend actually reads. If it is a different key, the picker changes nothing and every reply comes from the backend's default.</div>

  <label>Extra request fields <span class="hint">— JSON merged into every request body</span></label>
  <textarea id="identity" placeholder='{ "someField": "…", "nested": { … } }'></textarea>

  <label>Model parameters <span class="hint">— JSON: temperature, max_tokens, anything else</span></label>
  <textarea id="params" placeholder='{ "temperature": 0.3, "max_tokens": 4096 }'></textarea>

  <div class="grid">
    <div>
      <label>Prompt field <span class="hint">— body key holding the prompt</span></label>
      <input id="promptField" placeholder="prompt" />
    </div>
    <div>
      <label>Text field path <span class="hint">— blank = auto-detect</span></label>
      <input id="textPath" placeholder="(auto)" />
    </div>
  </div>

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
    <button id="clear" class="secondary">Clear credentials</button>
  </div>

  <div id="status"></div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      $('url').value = m.url || '';
      $('chatPath').value = m.chatPath || '';
      $('authHeader').value = m.authHeader || '';
      $('authPrefix').value = m.authPrefix || '';
      $('models').value = m.models || '';
      $('textPath').value = m.textPath || '';
      $('promptField').value = m.promptField || '';
      $('modelField').value = m.modelField || '';
      $('identity').value = m.identity === '{}' ? '' : m.identity;
      $('params').value = m.params === '{}' ? '' : m.params;
      $('maxResponseChars').value = m.maxResponseChars;
      $('maxContinuations').value = m.maxContinuations;
      $('saved').textContent = m.tokenLocation
        ? 'Token saved in ' + m.tokenLocation + '. Leave blank to keep it.'
        : 'No token saved yet.';
      $('savedCookie').textContent = m.hasCookie
        ? 'A cookie is saved. Leave blank to keep it.'
        : 'No cookie saved.';
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
      chatPath: $('chatPath').value,
      token: $('token').value,
      cookie: $('cookie').value,
      authHeader: $('authHeader').value,
      authPrefix: $('authPrefix').value,
      models: $('models').value,
      identity: $('identity').value,
      params: $('params').value,
      textPath: $('textPath').value,
      promptField: $('promptField').value,
      modelField: $('modelField').value,
      maxResponseChars: $('maxResponseChars').value,
      maxContinuations: $('maxContinuations').value,
    });
    $('token').value = '';
    $('cookie').value = '';
  };
  $('clear').onclick = () => vscode.postMessage({ type: 'clear' });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

module.exports = { openConfigPanel };
