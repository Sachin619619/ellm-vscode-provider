#!/usr/bin/env node
/**
 * Turns a DevTools HAR capture into the *shape* of your API — paths, header names,
 * body keys, response frame structure — with every value stripped out.
 *
 * Adapting src/corpClient.js needs that shape and nothing else. A HAR file itself
 * is full of live tokens, so this never sends anything anywhere: it reads the file,
 * prints a skeleton, and leaves you to decide whether even that is shareable.
 *
 *   1. Company chat site → DevTools → Network
 *   2. Send one message
 *   3. Right-click the request list → "Save all as HAR with content"
 *   4. node tools/describe-har.js capture.har
 *
 * Add --hosts to keep hostnames (they are redacted by default).
 *
 * Values are never printed. Strings become <string:len>, numbers <number>, and so
 * on, so you can read the output line by line before showing it to anyone.
 */
const fs = require('fs');

const KEEP_HEADER_VALUES = new Set([
  'content-type', 'accept', 'accept-encoding', 'cache-control', 'connection',
  'transfer-encoding', 'method', 'path', 'scheme',
]);

/** Anything that smells like a chat completion call. */
function isInteresting(entry) {
  const { request, response } = entry;
  const type = (response?.content?.mimeType || '') + (header(response, 'content-type') || '');
  const body = request?.postData?.text || '';
  return request?.method === 'POST'
    && (/event-stream|x-ndjson|json/i.test(type) || /stream|chat|complet|convers|message|prompt/i.test(request.url))
    && (body.length > 0 || /stream|chat|complet|convers/i.test(request.url));
}

function header(msg, name) {
  return msg?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
}

/** A value's shape, never its content. */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    // Brackets stay: "an array of one object" and "an object" are different wire
    // formats, and confusing them is a rewrite of corpClient.js in the wrong shape.
    return `[ ${shape(value[0], depth + 1)}${value.length > 1 ? `, … ×${value.length}` : ''} ]`;
  }
  if (typeof value === 'object') {
    if (depth > 4) return '{…}';
    const inner = Object.entries(value)
      .map(([k, v]) => `${k}: ${shape(v, depth + 1)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  if (typeof value === 'string') return `<string:${value.length}>`;
  return `<${typeof value}>`;
}

function redactUrl(url, keepHosts) {
  try {
    const u = new URL(url);
    const host = keepHosts ? u.host : '<host>';
    const query = [...u.searchParams.keys()];
    return `${u.protocol}//${host}${u.pathname}${query.length ? `?${query.map((k) => `${k}=<value>`).join('&')}` : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

/** Header names always; values only for the handful that carry no secrets. */
function describeHeaders(msg, label) {
  const headers = (msg?.headers || []).filter((h) => !h.name.startsWith(':'));
  if (!headers.length) return [];
  const lines = [`  ${label}:`];
  for (const h of headers.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = h.name.toLowerCase();
    const value = KEEP_HEADER_VALUES.has(name) ? h.value : `<redacted:${(h.value || '').length}>`;
    lines.push(`    ${h.name}: ${value}`);
  }
  return lines;
}

/** SSE / NDJSON bodies: the frame structure is what matters, not the text. */
function describeStream(text) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === '[DONE]' || !/^[[{]/.test(payload)) {
      if (payload && !frames.includes(`literal ${payload}`)) frames.push(`literal ${payload}`);
      continue;
    }
    try {
      // Every chunk frame is the same shape with a different length, so collapse
      // lengths here - otherwise one answer prints as fifty identical frames.
      const s = shape(JSON.parse(payload)).replace(/<string:\d+>/g, '<string>');
      if (!frames.includes(s)) frames.push(s);
    } catch { /* half a frame - skip it */ }
    if (frames.length >= 6) break;
  }
  return frames;
}

function main() {
  const args = process.argv.slice(2);
  const keepHosts = args.includes('--hosts');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/describe-har.js capture.har [--hosts]');
    process.exit(2);
  }

  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = (har.log?.entries || []).filter(isInteresting);

  if (!entries.length) {
    console.error(`No streaming POST requests found in ${file}.`);
    console.error('Capture again with the Network tab open *before* sending the message,');
    console.error('and use "Save all as HAR with content".');
    process.exit(1);
  }

  console.log(`# ${entries.length} candidate request(s) — values stripped, safe to read line by line\n`);

  entries.forEach((entry, i) => {
    const { request, response } = entry;
    console.log(`## ${i + 1}. ${request.method} ${redactUrl(request.url, keepHosts)}`);
    describeHeaders(request, 'request headers').forEach((l) => console.log(l));

    const body = request.postData?.text;
    if (body) {
      console.log('  request body:');
      try {
        console.log(`    ${shape(JSON.parse(body))}`);
      } catch {
        console.log(`    <non-json:${body.length} chars>`);
      }
    }

    console.log(`  response: ${response?.status} ${header(response, 'content-type') || response?.content?.mimeType || ''}`);
    const text = response?.content?.text;
    if (text) {
      const frames = describeStream(text);
      if (frames.length) {
        console.log('  response frames:');
        frames.forEach((f) => console.log(`    ${f}`));
      }
    } else {
      console.log('    (no response body in the HAR — re-save with content to get the frame shape)');
    }
    console.log('');
  });

  console.log('# Fill these into src/corpClient.js:');
  console.log('#   the path, the auth header NAME, the body keys, and how each frame');
  console.log('#   carries its text. No values needed.');
}

main();
