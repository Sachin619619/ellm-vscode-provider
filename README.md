# Enterprise LLM Provider for VS Code

Your company has an internal LLM. It's a chat website, all the good models are behind it, and
all you have is an auth token. It is **not** OpenAI-compatible, so no AI coding tool will talk
to it.

This extension makes it a first-class model inside VS Code chat and agent mode.

```
VS Code chat / agent  ──vscode.lm──▶  this extension  ──your auth header──▶  enterprise LLM
                                         │                                   (chat-only,
                                         ├─ wire-format translation           not OpenAI,
                                         ├─ tool-calling shim                 response cap)
                                         └─ response auto-continuation
```

No proxy process to babysit. The extension registers itself through VS Code's
[Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider),
so your models appear in the normal model picker next to everything else.

## Install

Grab the `.vsix` from [Releases](../../releases) and:

```bash
code --install-extension ellm-provider-0.1.0.vsix
```

Then **Cmd/Ctrl+Shift+P → “Enterprise LLM: Configure Connection”**, enter your endpoint URL
and auth token, press **Save & Test**. The models show up in the chat model picker.

Your token is stored in the OS keychain via VS Code's `SecretStorage` — never in
`settings.json`, never written to disk in plaintext, never sent anywhere except the endpoint
you configure.

## The three problems it solves

**1. The wire format isn't OpenAI.** All translation lives in
[`src/corpClient.js`](src/corpClient.js) — the only file you need to touch to point this at a
different backend. Everything above it consumes a neutral `{type:'text'|'finish'}` event
stream. The bundled example speaks `{modelAlias, turns:[{speaker, utterance}]}` and reads back
`{event:"chunk", payload:{deltaText}}` SSE frames, with the token on a custom `X-Corp-Auth`
header rather than `Authorization: Bearer`.

**2. Responses are capped.** Many internal gateways cut each response at a fixed size (5000
characters in the bundled example). That silently guillotines a generated file mid-function,
and the editor has no idea. [`src/continuation.js`](src/continuation.js) detects a capped
response, re-asks with the partial answer as context, and stitches the pieces into one stream.

Two things go wrong when stitching, both handled:

- *Overlap* — models re-say their last line. We cut the **shortest** suffix of the accumulated
  text that the continuation begins with. Shortest, not longest: in repetitive content several
  lengths match, and taking the longest silently eats real characters. Erring short leaves a
  visible duplicate; erring long corrupts the file with no trace.
- *Preamble* — “Sure, continuing:” plus a freshly re-opened ``` fence. Stripped, with fence
  parity tracked so a resumed code block stays one block.

**3. Agent mode needs tool calling.** VS Code only offers models that advertise `toolCalling`,
and expects structured calls back. If your backend is text-only,
[`src/toolshim.js`](src/toolshim.js) teaches it a `<tool_call>{…}</tool_call>` protocol and
converts what comes back into `LanguageModelToolCallPart`, including reassembly when a tag is
split across streaming chunks.

## Adapting it to your LLM

Open your company chat UI → DevTools → Network → send a message → find the request that
streams the answer. You need the endpoint URL, the auth header name, the request body shape,
and the response frame shape. Then rewrite `src/corpClient.js` to match — it's ~90 lines and
only has to yield `{type:'text', text}` events and a final `{type:'finish', reason}`, where
`reason: 'length'` means "was truncated, please continue".

Set `ellm.maxResponseChars` to your backend's cap (0 disables continuation) and
`ellm.maxContinuations` to bound how many rounds a single answer may take.

## Try it without a real backend

`test-server/` is a stand-in enterprise LLM: chat-only, non-OpenAI, token-guarded, hard 5000
character cap, with a browser chat UI. It proxies a local [Ollama](https://ollama.com) daemon
for real model output.

```bash
cd test-server
echo "my-test-token" > .token
node server.js            # http://127.0.0.1:9800
```

Point the extension at `http://127.0.0.1:9800` with that token.

## Tests

```bash
npm install
node test/runTest.js      # launches real VS Code and drives the genuine vscode.lm API
```

The suite verifies model discovery, an answer longer than the upstream cap arriving intact
with no duplicated lines across the seam, a tool call surfacing as a `LanguageModelToolCallPart`,
and a full tool-result round trip.

## Limits worth knowing

- **Inline completions are unaffected.** Copilot's ghost-text completions, semantic search and
  embeddings features run on GitHub's infrastructure; a model provider only changes chat and
  agents.
- **Enterprise policy can disable it.** On Copilot Business/Enterprise an administrator can
  turn off third-party model providers.
- **Chat-session tokens expire.** When yours does, the models quietly vanish from the picker —
  discovery returns an empty list rather than throwing, so the picker keeps working for other
  providers. Reconfigure to restore them.

## License

MIT
