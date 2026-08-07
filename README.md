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
code --install-extension ellm-provider-0.2.0.vsix
```

Requires VS Code 1.104 or newer.

Then **Cmd/Ctrl+Shift+P → “Enterprise LLM: Configure Connection”**, enter your endpoint URL
and auth token, press **Save & Test**. The models show up in the chat model picker.

## Where your token goes

Never into `settings.json`, never anywhere but the endpoint you configure. Which store it
lands in is up to `ellm.tokenStorage`:

| `ellm.tokenStorage` | Where | Encrypted |
|---|---|---|
| `global` (default) | VS Code global storage — this machine, every folder | no |
| `workspace` | VS Code workspace storage — this folder only | no |
| `keychain` | OS keychain via `SecretStorage` | yes |

The keychain is the only encrypted option, but it is deliberately **not** the default: managed
corporate machines can refuse `SecretStorage` outright, and a token that silently fails to save
is worse than one saved in the clear. Pick `keychain` if your machine allows it — if the write
is refused the token falls back to global storage and the panel tells you so.

For the same reason, a `settings.json` that VS Code will not write — a stray comma somewhere
unrelated is enough — no longer blocks configuration. The endpoint and limits fall back to the
extension's own storage, and everything keeps working.

## The three problems it solves

**1. The wire format isn't OpenAI.** All translation lives in
[`src/corpClient.js`](src/corpClient.js). Everything above it consumes a neutral
`{type:'text'|'finish'}` event stream.

Most of the differences between backends are *configuration*, not code, so for a large class of
gateways there is nothing to write at all:

| setting | what it is | default |
|---|---|---|
| `ellm.url` | origin | — |
| `ellm.chatPath` | path of the streaming endpoint | `/chat` |
| `ellm.authHeader` | header the token rides in | `X-Corp-Auth` |
| `ellm.authPrefix` | text before the token, e.g. `Bearer ` | *(none)* |
| `ellm.promptField` | body key holding the prompt | `prompt` |
| `ellm.models` | model names, comma separated | — |
| `ellm.textPath` | dot-path to the text in a frame | *(auto-detect)* |

Two more live in the panel rather than `settings.json`, because they are private: a **Cookie**
header, for gateways that want signed cookies alongside the token, and an **extra request
fields** JSON object merged into every request body — the tenant, region and user block some
backends require. Streamed frames are read tolerantly: the text is found in whichever of ~12
common shapes the backend uses, and the first raw frame is logged to the *Enterprise LLM*
output channel so an unknown shape is a one-line diagnosis rather than a mystery.

Backends that keep conversation history server-side are handled too: VS Code replays the whole
conversation every turn, so the turn list is flattened into one labelled prompt and server-side
memory is left off — otherwise every turn is remembered twice.

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
converts what comes back into `LanguageModelToolCallPart`.

Models improvise, so the scanner is forgiving about how the call actually arrives:

- a tag **split across streaming chunks** is reassembled, never half-emitted
- a **mangled closing tag** (`</tool_call}`, or none at all) is still parsed as a call rather
  than dumped on the user as raw markup
- a **bare, untagged** `{"name": …, "arguments": …}` answer is recognised as the call it is
- genuinely malformed JSON inside the tags *is* shown as text, so the model can self-correct

## “Token rejected by the enterprise LLM”

Nine times out of ten the token is fine and the **request** is wrong. A server that has never
heard of the path you asked for answers `401` just as readily as one that dislikes your token,
so the error now reports the status, the URL it tried and whatever the server said back. Read
that line before touching the token:

| What you see | What it means |
|---|---|
| `No such endpoint (404 …)` | The chat path is wrong. Fix it in the panel. |
| `answered with a web page rather than an API response` | The URL is the chat site, not its API — or a cookie the gateway wants is missing. A browser session cookie is not an API token. |
| `Token rejected (401 …). Server said: …` | A real rejection — or the right token in the wrong header. Try `Authorization`, and check whether a prefix is expected. |
| `streamed a response but no text could be found` | The connection works. Read the `first raw frame:` line in the *Enterprise LLM* output channel and set `ellm.textPath`. |

The header the token rides in is the single most common mismatch, and it needs no code change:

| setting | default | typical alternative |
|---|---|---|
| `ellm.authHeader` | `X-Corp-Auth` | `Authorization` |
| `ellm.authPrefix` | *(empty)* | `Bearer ` — keep the trailing space |

Both are on the config panel. Note that plenty of gateways expect the **raw** token with no
prefix at all, so an empty prefix is a real answer, not an unfinished one.

## Adapting it to your LLM

Open your company chat UI → DevTools → Network → send a message → find the request that
streams the answer. You need the endpoint URL, the path, the auth header name, the request body
shape, and the response frame shape.

**Try the settings first.** If the backend takes a prompt in one body field and streams SSE
back, the panel alone will do it: URL, chat path, auth header, prompt field, model name, plus
any constant fields the body needs in the *extra request fields* box. No code change.

Only if the shape is stranger than that — a turn list with an unusual schema, a non-SSE
transport, a two-step submit-then-poll flow — does `src/corpClient.js` need editing. It only has
to yield `{type:'text', text}` events and a final `{type:'finish', reason}`, where
`reason: 'length'` means "was truncated, please continue".

Internal endpoints are usually confidential, and a HAR capture is full of live tokens. If you
want that shape written down — or reviewed by someone else — without the secrets going with it,
save the capture (**Save all as HAR with content**) and run:

```bash
node tools/describe-har.js capture.har
```

It reads the file locally, sends nothing anywhere, and prints structure only — every value
replaced by its type, hostnames and query values redacted:

```
## 1. POST https://<host>/api/v3/chat/stream?tenant=<value>
  request headers:
    Authorization: <redacted:45>
    content-type: application/json
  request body:
    { modelAlias: <string:9>, turns: [ { speaker: <string:5>, utterance: <string:8> } ], streaming: <boolean> }
  response: 200 text/event-stream
  response frames:
    { event: <string>, payload: { deltaText: <string> } }
    { event: <string>, stopReason: <string>, charCount: <number> }
```

That is everything `corpClient.js` needs, and it is short enough to read line by line before
you decide it is shareable. Pass `--hosts` to keep hostnames.

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
npm test                  # fast, deterministic: the tool-call scanner and client errors
npm run test:e2e          # launches real VS Code and drives the genuine vscode.lm API
```

The E2E suite verifies model discovery, an answer longer than the upstream cap arriving intact
with no duplicated lines across the seam, a tool call surfacing as a `LanguageModelToolCallPart`,
a full tool-result round trip, and that the token survives without the OS keychain. It needs
`test-server/` running, and takes its connection from the environment:

```bash
ELLM_TEST_URL=http://127.0.0.1:9800 ELLM_TEST_TOKEN=$(cat test-server/.token) \
ELLM_TEST_WORKSPACE=/path/to/some/repo npm run test:e2e
```

It runs in a throwaway VS Code profile, so it never touches your real settings or tokens.
What a model chooses to emit varies run to run, so the awkward shapes are pinned in the
deterministic suite rather than left to the live one.

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
