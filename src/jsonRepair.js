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

    // A bare quote only reaches here from the ambiguous parser, which has already
    // established that this one does not end the string.
    if (c === '"') {
      out += '\\"';
      continue;
    }

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
 * Where a string value may end, when the model did not escape its quotes.
 *
 * A model asked to put a source file inside a JSON string writes the file the way
 * it writes files - `"""docstring"""`, `font="Segoe UI"`, `["a", "b"]` - and every
 * one of those quotes ends the string as far as a parser is concerned. repairJson
 * cannot help: it uses quotes to find string boundaries, so it is already lost by
 * the time it looks inside one.
 *
 * The only honest reading is that a quote is *ambiguous* - it might end the string
 * or be part of it - so the string is parsed as a set of possibilities and the
 * structure decides. A quote can only close a string if what follows is `,` `}`
 * `]` `:` or the end, which prunes most of them; the rest are settled by whether
 * the remainder of the document then parses. `"alpha",` inside a Python list
 * looks like a perfect ending until you try to read what comes after it and find
 * no key and no colon.
 *
 * Nearest candidate first, so a short value like a file path is not swallowed by
 * a later quote belonging to something else.
 */
const STEP_BUDGET = 200000;
const MAX_AMBIGUOUS_CHARS = 262144;
const SLICE = Symbol('slice');

/**
 * What may legally follow a string, by where it sits in the grammar.
 *
 * This is the whole of the pruning. Without it, a key is looked for anywhere a
 * quote appears, so every `["a", "b"]` in a file body starts a search that runs
 * to the end of the document and a 50KB file takes minutes.
 */
const EXPECT_KEY = new Set([':']);
const EXPECT_OBJ_VALUE = new Set([',', '}']);
const EXPECT_ARRAY_ITEM = new Set([',', ']']);
const EXPECT_END = new Set(['eof']);

function parseAmbiguous(raw) {
  // Cost grows with the number of quotes, and this runs while a reply is
  // streaming. A tool call this large is not a tool call worth waiting seconds
  // to guess at - a realistic file body parses in well under a second.
  if (raw.length > MAX_AMBIGUOUS_CHARS) return null;

  const s = raw;
  let steps = 0;

  const ws = (i) => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    return i;
  };

  const spend = () => {
    steps += 1;
    if (steps > STEP_BUDGET) throw new RangeError('json-repair budget');
  };

  /**
   * Yields the positions a string could end at, never its text.
   *
   * Decoding at each candidate is what makes this quadratic: a 50KB file body
   * with a couple of thousand quotes in it means a couple of thousand candidates,
   * and re-escaping the whole body at every one of them turns a parse into ten
   * seconds of work that then hits the budget and fails anyway. Positions are
   * O(1) to carry, so the text is built once, at the end, for the reading that
   * actually parsed.
   */
  function* pString(i, expect, keyLike = false) {
    if (s[i] !== '"') return;
    let j = i + 1;

    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      // A key never spans lines. Without this, every `"a", "b"` inside a file
      // body starts a key scan that runs to the end of the document, and a big
      // enough file turns the parse into minutes of work.
      if (keyLike && (c === '\n' || c === '\r')) return;
      if (c === '"') {
        const k = ws(j + 1);
        if (expect.has(s[k] === undefined ? 'eof' : s[k])) {
          spend();
          yield [{ [SLICE]: [i + 1, j] }, j + 1];
        }
        j += 1; // not the end after all - it belongs to the value
        continue;
      }
      j += 1;
    }
  }

  function* pValue(i, expect) {
    const at = ws(i);
    const c = s[at];
    if (c === '"') { yield* pString(at, expect); return; }
    if (c === '{') { yield* pObject(at); return; }
    if (c === '[') { yield* pArray(at); return; }

    const lit = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(at));
    if (lit) yield [JSON.parse(lit[1]), at + lit[1].length];
  }

  const decode = (node) => {
    const [from, to] = node[SLICE];
    return JSON.parse(`"${repairStringBody(s.slice(from, to))}"`);
  };

  /** Turn the slices of the reading that parsed into their text, once. */
  const materialise = (node) => {
    if (Array.isArray(node)) return node.map(materialise);
    if (node && typeof node === 'object') {
      if (node[SLICE]) return decode(node);
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, materialise(v)]));
    }
    return node;
  };

  function* pMembers(i, acc) {
    const at = ws(i);
    for (const [keyNode, afterKey] of pString(at, EXPECT_KEY, true)) {
      let key;
      try {
        key = decode(keyNode); // keys are short, and there are few of them
      } catch { continue; }
      const colon = ws(afterKey);
      if (s[colon] !== ':') continue;
      for (const [value, afterValue] of pValue(colon + 1, EXPECT_OBJ_VALUE)) {
        const end = ws(afterValue);
        const next = { ...acc, [key]: value };
        if (s[end] === ',') yield* pMembers(end + 1, next);
        else if (s[end] === '}') yield [next, end + 1];
      }
    }
  }

  function* pObject(i) {
    const at = ws(i + 1);
    if (s[at] === '}') { yield [{}, at + 1]; return; }
    yield* pMembers(at, {});
  }

  function* pItems(i, acc) {
    for (const [value, afterValue] of pValue(i, EXPECT_ARRAY_ITEM)) {
      const end = ws(afterValue);
      const next = [...acc, value];
      if (s[end] === ',') yield* pItems(end + 1, next);
      else if (s[end] === ']') yield [next, end + 1];
    }
  }

  function* pArray(i) {
    const at = ws(i + 1);
    if (s[at] === ']') { yield [[], at + 1]; return; }
    yield* pItems(at, []);
  }

  try {
    for (const [value, end] of pValue(0, EXPECT_END)) {
      if (ws(end) !== s.length) continue;
      try {
        return { value: materialise(value), repaired: true };
      } catch { /* this reading does not decode - try the next one */ }
    }
  } catch {
    return null; // budget exhausted - better to give up than to hang the stream
  }
  return null;
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
  if (fixed !== raw) {
    try {
      return { value: JSON.parse(fixed), repaired: true };
    } catch { /* the damage is not the kind repairJson can see */ }
  }

  // Last resort: the quotes themselves are unreliable.
  return parseAmbiguous(raw);
}

module.exports = { repairJson, parseLenient, parseAmbiguous };
