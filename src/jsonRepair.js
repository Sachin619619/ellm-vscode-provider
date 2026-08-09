/**
 * Make almost-JSON parseable.
 *
 * Two producers here write JSON without a serialiser and get it wrong in the same
 * two ways:
 *
 *   - a backend that builds stream frames by concatenating strings leaves literal
 *     newlines and tabs inside string literals, which JSON forbids
 *   - a model asked to emit a tool call writes a Windows path the way the OS
 *     spells it, `"c:\Users\dev\notes.md"`, and `\U` is not an escape sequence
 *
 * Both are otherwise fatal: the frame or the tool call is thrown away and the user
 * sees raw JSON in the chat instead of an answer or a file edit. Repairing beats
 * showing the wreckage.
 *
 * Only the inside of string literals is touched. Structure - braces, commas,
 * colons - is left exactly as it arrived, so genuinely malformed JSON still fails
 * to parse rather than being guessed at.
 */

/** Control characters JSON spells out rather than carrying literally. */
const CONTROL_ESCAPES = {
  '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f',
};

/** The characters a backslash is allowed to escape in JSON. */
const VALID_ESCAPE = /["\\/bfnrt]/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * A value that opens `c:\` or `\\server\` is a filesystem path, so every backslash
 * in it is a separator.
 *
 * This has to be decided per value rather than per character, because the two
 * readings are otherwise indistinguishable: in `c:\Users\dev\notes.md` the `\n` of
 * `\notes` is a perfectly valid escape, and repairing character by character turns
 * the path into `c:\Users\dev` + newline + `otes.md`. Nothing downstream would
 * report that - the edit would just quietly address the wrong file.
 */
const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\])/;

function escapeControl(c) {
  if (c >= ' ') return c;
  return CONTROL_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Repair the raw text between one pair of quotes. */
function repairStringBody(body) {
  const isPath = WINDOWS_PATH.test(body);
  let out = '';

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    if (c !== '\\') {
      out += escapeControl(c);
      continue;
    }

    const next = body[i + 1];

    // Already doubled - leave it alone, whichever kind of value this is. A path
    // the model escaped correctly must survive the path branch untouched.
    if (next === '\\') {
      out += '\\\\';
      i += 1;
      continue;
    }

    if (isPath) {
      out += '\\\\'; // a lone separator
      continue;
    }

    if (next === undefined) {
      // A trailing backslash escapes whatever gets appended next, which is never
      // what was meant at the end of a truncated value.
      out += '\\\\';
      continue;
    }
    if (next === 'u' && HEX4.test(body.slice(i + 2, i + 6))) {
      out += body.slice(i, i + 6);
      i += 5;
      continue;
    }
    if (VALID_ESCAPE.test(next)) {
      out += c + next;
      i += 1;
      continue;
    }

    out += '\\\\'; // not an escape at all
  }

  return out;
}

function repairJson(raw) {
  let out = '';
  let i = 0;

  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i];
      i += 1;
      continue;
    }

    // Find the closing quote, stepping over escaped characters so a `\"` inside
    // the value does not look like the end of it.
    let end = -1;
    for (let j = i + 1; j < raw.length; j++) {
      const c = raw[j];
      if (c === '\\') { j += 1; continue; }
      if (c === '"') { end = j; break; }
    }

    const closed = end !== -1;
    const body = raw.slice(i + 1, closed ? end : raw.length);
    out += `"${repairStringBody(body)}${closed ? '"' : ''}`;
    i = closed ? end + 1 : raw.length;
  }

  return out;
}

/**
 * Parse `raw`, repairing it only if it will not parse as it stands. Returns
 * `{ value, repaired }`, or null when even the repair does not parse - a caller
 * that wants to report "we had to fix this" needs to know which happened.
 */
function parseLenient(raw) {
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch { /* fall through and try to fix it */ }

  const fixed = repairJson(raw);
  if (fixed === raw) return null;

  try {
    return { value: JSON.parse(fixed), repaired: true };
  } catch {
    return null;
  }
}

module.exports = { repairJson, parseLenient };
