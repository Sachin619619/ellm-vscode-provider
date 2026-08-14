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
code --install-extension ellm-provider-0.3.2.vsix
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
| `ellm.modelField` | body key holding the picked model | `model` |
| `ellm.models` | model names, comma separated | — |
| `ellm.textPath` | dot-path to the text in a frame | *(auto-detect)* |
| `ellm.contextChars` | prompt characters the backend accepts | `400000` |
| `ellm.messagesField` | body key for a real message array | *(off — flattened)* |
| `ellm.messagesFormat` | `openai` / `speaker` / `anthropic` | `openai` |
| `ellm.imageField` | body key holding attached images | *(text-only)* |

### Attaching images

Left blank, `ellm.imageField` means the backend takes text only, and VS Code says so up front —
attach a screenshot and Copilot answers *"Vision is not supported by the current model"* rather
than sending it. That refusal is the honest outcome, and it is deliberately not papered over: a
chat endpoint that takes one prompt string has nowhere to put a picture, and a model given the
caption without the image does not report a missing attachment — it describes one that was never
there. If an image does reach a text-only turn, the prompt names it and tells the model it cannot
see it.

Set `ellm.imageField` to the body key your backend reads — `images`, `attachments` — and images
ride along as an array of `data:` URLs, with `imageInput` advertised to VS Code so the attach
button lights up. Turn it on only once you know that key exists; the value is what the extension
trusts when it decides whether it can see.

`ellm.modelField` is the one worth reading twice. A backend that doesn't recognise the key it
arrives under doesn't complain — it answers from its default, and the reply looks exactly like a
correct one. So picking a model in VS Code appears to work while every answer comes from the
same model. Two guards: the panel warns when a field in the **extra request fields** block is
fixed at something that also looks like a model name (which is what a request copied out of
DevTools leaves behind — the real selector, frozen at whatever that one request used), and each
request logs the field and value it sent to the output channel, so it can be compared against a
DevTools capture directly.

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
and expects structured calls back. A plain chat endpoint has no such thing — no tool schemas
going out, no structured calls coming back, no notion of a tool turn in the history. Without
something in between, your model simply never appears in agent mode.

### Whose tools are these?

**The editor's.** This extension contributes no tools of its own — no `registerTool`, no
`languageModelTools` contribution. Reading files, editing them, running terminal commands,
searching the workspace, and asking you to approve any of it: all of that belongs to the chat
client, and none of it changes. What this extension does is let a text-only model take part in
a conversation the client is already running.

```
   chat client (agent mode)
   owns the tools, executes them, asks for approval
            │  options.tools  ─ read_file, edit, run_in_terminal, …
            ▼
   ┌────────────────────────────────────────────────────────┐
   │  this extension                                        │
   │                                                        │
   │  out ─ tool schemas written into the prompt as text,   │
   │        with the protocol to answer in:                 │
   │        <tool_call>{"name":…,"arguments":…}</tool_call> │
   │                                                        │
   │  in  ─ that tag scanned back out of the streamed text  │
   │        and rebuilt as a LanguageModelToolCallPart      │
   └────────────────────────────────────────────────────────┘
            │  POST {promptField: "…"}          ▲  text/event-stream
            ▼                                   │
   your enterprise LLM — a plain chat endpoint, none the wiser
```

The result comes back the same way in reverse: the client executes the tool and hands back a
result, which is rendered into the next prompt as `TOOL RESULT (call_id): …`, because a chat
endpoint has nowhere else to put it. The model reads it as conversation and continues.

**This is emulation, not a native capability.** A real tool API guarantees the shape of what
comes back; a prompt does not. Whether a given model honours the protocol is a property of that
model, and a gateway that injects its own system prompt can compete with the instructions. The
telling symptom is `0 tool call(s)` in the *Enterprise LLM* output channel while the model
talks about reading a file instead of calling the tool.

Which is why the scanner in [`src/toolshim.js`](src/toolshim.js) is forgiving about how the
call actually arrives:

- a tag **split across streaming chunks** is reassembled, never half-emitted
- a **mangled closing tag** (`</tool_call}`, or none at all) is still parsed as a call rather
  than dumped on the user as raw markup
- the **tags are matched as a shape, not a string**: `<tool-call>`, `<TOOL_CALL>`, `<tool_call >`,
  `<tool_use>` and `<function_call>` all count. Measured against thirteen replies a chat-tuned
  model really produces, matching the literal `<tool_call>` caught six; the other seven were
  printed into the chat as raw markup and never ran
- a call **wrapped in a ```json fence** — which is how a model that has spent its life in a chat
  window writes JSON, whatever it was told — is unwrapped, and the fence does not survive into
  the chat as an empty code block
- a **bare, untagged** `{"name": …, "arguments": …}` is recognised **anywhere in the reply**, not
  only when it is the first thing in it. A model that writes "I'll read that file now." before
  the call used to leak the whole call as prose
- the shapes a model reaches for **instead of** the one it was given are normalised: `tool_name`
  or `recipient_name` for the name, `parameters`/`args`/`input` for the arguments, a
  `functions.` prefix on the name, the whole OpenAI `{"function": {…}}` envelope, and a list
  when it means one call
- **`"arguments"` given as a JSON *string*** rather than an object is parsed through. This one is
  worse than a leak: it parses cleanly, so nothing looks wrong, and the tool is then handed a
  string where its schema says object and reads every field as `undefined`
- an **untagged call cut off mid-write** keeps the continuation layer going, the same as a tagged
  one. Only the name is checked against the tools the client actually offered, so prose that
  merely contains a brace does not buy extra round trips
- a **file body written with unescaped quotes** — a Python `"""docstring"""`, a Windows path —
  is repaired rather than thrown away (see [`src/jsonRepair.js`](src/jsonRepair.js))
- a call the model **restarted** instead of continuing replaces the half it walked away from,
  rather than being spliced onto it — that splice is how a written file ends up with its
  middle duplicated
- a call that still will not parse is **not** dumped into the chat as raw markup. Tool calls
  routinely carry a whole source file, and a chat full of that markup buries the answer while
  telling you nothing. One line goes to the chat instead — addressed to the model as much as
  to you, since VS Code replays it as the previous assistant turn, so it is the model's only
  chance to learn the call never ran — and the reason, with the length and the brace balance,
  goes to the *Enterprise LLM* output channel as `TOOL CALL PROBLEM:`

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

## “No utility model is configured for `copilot-utility-small`”

Not this extension. VS Code **1.128** started routing its own small side jobs — chat title
generation, commit messages, intent detection, the *Optimizing tool selection* pass — to a
separate **utility model**, and it refuses to guess one when the main agent model is BYOK,
which every model this extension serves is. On a machine with a live Copilot token the
default quietly resolves to Copilot's own utility models and nothing is ever said; without
one, the very first agent turn fails with that line. That is the whole difference between the
laptop where it works and the laptop where it does not — the extension, the token and the URL
are irrelevant to it.

Set one setting:

| setting | value | effect |
|---|---|---|
| `chat.byokUtilityModelDefault` | `mainAgent` | side jobs go to the enterprise LLM you already picked |
| `chat.byokUtilityModelDefault` | `copilot` | side jobs go to GitHub Copilot — only if that account has a token |
| `chat.byokUtilityModelDefault` | `none` *(default)* | no utility model, and agent mode fails as above |

In the UI it is **Settings → Chat: Byok Utility Model Default → Main Agent Model**. If
`chat.utilityModel` or `chat.utilitySmallModel` was set by hand earlier, reset both to
*Default* — a named model there outranks this setting.

`mainAgent` sends those side jobs through the same capped, chat-only backend as everything
else, so a title or a commit message costs a real round trip. That is the price of not having
a second model; it is not a malfunction.

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
`ellm.maxContinuations` to bound how many rounds a single answer may take. Every default
comes from the `contributes.configuration` block in `package.json` and nowhere else — the
panel and the provider both read it rather than restating it, because the version that
restated it disagreed with itself, and pressing **Save** then quietly cut `maxContinuations`
from 20 to 8 and with it the longest answer that could still be recovered.

## Sending a real message array

By default the whole conversation is flattened into **one prompt string**, labelled
`System:` / `User:` / `Assistant:`, because the original backend took a single prompt and kept
history itself. That works, but the labels are just words inside a string: nothing separates an
instruction the model must obey from a quotation of one, and a file whose contents happen to
contain `User:` reads as a turn boundary.

If your backend accepts a real array, set **`ellm.messagesField`** to the body key (usually
`messages`) and pick a shape with **`ellm.messagesFormat`**:

| format | each element | notes |
|---|---|---|
| `openai` | `{ role: system\|user\|assistant, content: "…" }` | the default |
| `speaker` | `{ speaker: system\|human\|assistant, utterance: "…" }` | |
| `anthropic` | `{ role: user\|assistant, content: [{ type: "text", text }] }` | system text is hoisted to a top-level `system` field, which is where that API wants it |

The array **replaces** the flattened prompt — sending both would show the backend every turn
twice.

> **Verify it before trusting it.** This is opt-in for a reason: a backend handed a body field it
> does not recognise does not complain. It ignores the field, answers from whatever it *did*
> understand, and returns a perfectly ordinary reply — so a conversation that was never delivered
> looks exactly like one that was. Set `ellm.logRequestBody` to `keys`, make one request, and read
> the payload in the **Enterprise LLM** output channel: the conversation shows up as
> `system(2688 chars) user(64 chars) assistant(79 chars)`. If the reply is fine but that line is
> missing or the array is empty, the field name is wrong.

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

## Getting good agent behaviour out of it

A shimmed model is doing by convention what a native tool-calling model does by protocol, so a
few settings decide whether agent mode feels usable:

- **`ellm.contextChars` is a promise you make on the backend's behalf.** It becomes the context
  window the model advertises, and VS Code fills it. Set it above what the backend accepts and
  the backend truncates — from the *start* of the prompt, which is where the conversation and
  the system instructions live. Nothing in the reply reveals this happened. If long sessions
  start ignoring tools or forgetting earlier turns, lower it first.
- **One call at a time.** The model is asked to send a single `<tool_call>` and stop. Batching
  independent calls was tried and reverted with v0.5.0: through a 5000-char cap, a reply
  carrying two calls is a reply twice as likely to be guillotined mid-JSON.
- **Tool instructions are prepended.** The schemas sit at the front of the prompt, ahead of the
  conversation. Putting them at the back was tried twice and broke the plugin outright both
  times — with a real VS Code tool list the block is ~12,000 characters, so appending it pushes
  the user's actual request to the front, which is the end this backend truncates from.
- **The model is told to keep working.** A chat-tuned model does one useful thing and then asks
  "shall I continue?", and a reply with no tool call in it *ends the agent loop* — so the
  politeness costs you the task. The protocol tells it, in as many words, not to ask permission
  for ordinary steps, not to stop to report progress, and not to end a turn with a question.
- **`chat.agent.maxRequests` is VS Code's own limit, not this plugin's.** After that many tool
  calls in one turn VS Code itself stops and asks whether to keep going. The default is 25;
  raise it if you are being asked to continue part-way through real work.
- **Check `params`.** The model parameters block is usually pasted from a DevTools capture of
  the web chat UI, so it can carry that UI's sampling settings. Agent work wants a low
  temperature; a chat default of `0.7` shows up as a model that improvises around instructions.

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
