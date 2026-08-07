# corp-ellm-server — stand-in enterprise LLM

A test double for a chat-only enterprise LLM, so the extension can be developed and tested
without touching a real one. Real model output (via the local Ollama daemon), but wrapped
in a deliberately awkward interface:

- **Chat-only, not OpenAI-compatible.** `{modelAlias, turns:[{speaker, utterance}]}` in;
  `{event:"chunk", payload:{deltaText}}` SSE frames out. No `/v1`, no `choices`, no `delta`.
- **Token-authenticated** on a custom header: `X-Corp-Auth`, no `Bearer` prefix.
- **Hard 5000-character cap per response**, reported as `stopReason: "charLimit"`.

## Run

```bash
node server.js          # http://127.0.0.1:9800
```

Create `.token` with any string (gitignored). Override with `CORP_TOKEN`, cap with `CHAR_CAP`,
port with `PORT`.

Open `http://127.0.0.1:9800/` for the chat website — paste the token, press Connect. Ask for
something long and the footer shows `stopReason=charLimit` when the answer is guillotined.

## API

| Route | Notes |
|---|---|
| `GET /corp/v2/models` | `{models:[{alias,label,contextChars}], limits:{maxResponseChars}}` |
| `POST /corp/v2/converse` | `{modelAlias, turns, streaming}` → SSE `chunk` / `complete` / `EOM` |

Both require `X-Corp-Auth`. A wrong token returns `401 {"event":"error","code":"INVALID_TOKEN"}`.

Backed by `gpt-oss:120b-cloud` through `http://127.0.0.1:11434/v1/chat/completions`
(Ollama). Signed-in Ollama installs serve cloud models with no API key. Change the backend
with `OLLAMA_URL`, the model list in `server.js`.
