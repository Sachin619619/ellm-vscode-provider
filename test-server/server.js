/**
 * Stand-in for the company's "enterprise LLM": a CHAT-ONLY service that is
 * deliberately NOT OpenAI-compatible, guarded by an auth token, and hard-capped
 * at 5000 characters per response.
 *
 * Backed by the local Ollama daemon so it produces real model output.
 *
 *   node server.js          # http://127.0.0.1:9800  (chat UI at /)
 *
 * Wire format - nothing here matches OpenAI, on purpose:
 *   POST /corp/v2/converse
 *   header  X-Corp-Auth: <token>              (not Authorization, not Bearer)
 *   body    { modelAlias, turns:[{speaker,utterance}], streaming }
 *   SSE     data: {"event":"chunk","payload":{"deltaText":"..."}}
 *           data: {"event":"complete","stopReason":"finished"|"charLimit"}
 *           data: EOM
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9800);
const CHAR_CAP = Number(process.env.CHAR_CAP || 5000);
const TOKEN = process.env.CORP_TOKEN || readFileSync(join(HERE, '.token'), 'utf8').trim();
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/v1/chat/completions';

const MODELS = [
  { alias: 'corp-fast', label: 'Corp Fast', upstream: 'gpt-oss:120b-cloud', contextChars: 400000 },
  { alias: 'corp-reasoning', label: 'Corp Reasoning', upstream: 'gpt-oss:120b-cloud', contextChars: 400000 },
];

const SPEAKER_TO_ROLE = { human: 'user', assistant: 'assistant', system: 'system' };

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleConverse(req, res) {
  if ((req.headers['x-corp-auth'] || '') !== TOKEN) {
    return json(res, 401, { event: 'error', code: 'INVALID_TOKEN', message: 'X-Corp-Auth missing or expired' });
  }

  const body = await readBody(req);
  const model = MODELS.find((m) => m.alias === body.modelAlias) ?? MODELS[0];
  const messages = (body.turns ?? []).map((t) => ({
    role: SPEAKER_TO_ROLE[t.speaker] ?? 'user',
    content: t.utterance ?? '',
  }));

  const upstream = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.upstream, messages, stream: true, max_tokens: 4096 }),
  });

  if (!upstream.ok) {
    return json(res, 502, { event: 'error', code: 'UPSTREAM', message: await upstream.text() });
  }

  const streaming = body.streaming !== false;
  if (streaming) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
  }

  let emitted = 0;
  let full = '';
  let capped = false;
  let buffer = '';
  const decoder = new TextDecoder();

  outer:
  for await (const raw of upstream.body) {
    buffer += decoder.decode(raw, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;

      let piece;
      try {
        piece = JSON.parse(data).choices?.[0]?.delta?.content ?? '';
      } catch {
        continue;
      }
      if (!piece) continue;

      // The hard per-response character cap.
      if (emitted + piece.length > CHAR_CAP) {
        piece = piece.slice(0, CHAR_CAP - emitted);
        capped = true;
      }
      if (piece) {
        emitted += piece.length;
        full += piece;
        if (streaming) res.write(`data: ${JSON.stringify({ event: 'chunk', payload: { deltaText: piece } })}\n\n`);
      }
      if (capped) break outer;
    }
  }

  const stopReason = capped ? 'charLimit' : 'finished';
  console.log(`[corp] ${model.alias} -> ${emitted} chars, stopReason=${stopReason}`);

  if (streaming) {
    res.write(`data: ${JSON.stringify({ event: 'complete', stopReason, charCount: emitted })}\n\n`);
    res.write('data: EOM\n\n');
    return res.end();
  }
  return json(res, 200, { event: 'complete', payload: { fullText: full }, stopReason, charCount: emitted });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,x-corp-auth',
      });
      return res.end();
    }

    if (path === '/' || path === '/index.html') {
      const html = readFileSync(join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (path === '/corp/v2/models') {
      if ((req.headers['x-corp-auth'] || '') !== TOKEN) {
        return json(res, 401, { event: 'error', code: 'INVALID_TOKEN' });
      }
      return json(res, 200, {
        models: MODELS.map(({ alias, label, contextChars }) => ({ alias, label, contextChars })),
        limits: { maxResponseChars: CHAR_CAP },
      });
    }

    if (path === '/corp/v2/converse' && req.method === 'POST') return await handleConverse(req, res);

    return json(res, 404, { event: 'error', code: 'NOT_FOUND', path });
  } catch (err) {
    console.error('[corp]', err);
    if (!res.headersSent) json(res, 500, { event: 'error', code: 'INTERNAL', message: String(err) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`corp eLLM on http://127.0.0.1:${PORT}`);
  console.log(`  chat UI      http://127.0.0.1:${PORT}/`);
  console.log(`  api          POST /corp/v2/converse   header X-Corp-Auth`);
  console.log(`  response cap ${CHAR_CAP} chars`);
  console.log(`  backing model ${MODELS[0].upstream} via ${OLLAMA}`);
});
