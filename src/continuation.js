/**
 * Transparent continuation for an upstream that caps each response (5000 chars here).
 *
 * A hard cap is fatal for a coding agent: a file write gets guillotined mid-function
 * and the chat client never knows. So when a round comes back at the cap we re-ask
 * with the partial answer as context and stitch, streaming the whole time.
 */

const CONTINUE_INSTRUCTION = [
  'Continue your previous response from exactly where it stopped.',
  '',
  '- Do not repeat any text you already wrote.',
  '- Do not add a preamble such as "Sure" or "Continuing".',
  '- Do not summarise what you wrote so far.',
  '- If you stopped inside a code block, resume the code directly. Do NOT re-open the ``` fence.',
  '- If you stopped mid-word or mid-line, resume mid-word.',
].join('\n');

/** Chars of a continuation buffered before emitting, so overlap can be removed. */
const HEAD_WINDOW = 400;

/**
 * Nothing below this many chars counts as a repeat: shorter matches happen by luck
 * inside repetitive content (indentation, boilerplate) and would delete real output.
 */
const MIN_OVERLAP = 24;

/**
 * Drop a leading repeat of what we already have.
 *
 * If the model re-said its last k characters, the continuation starts with the last k
 * chars of what we have - so we take the SHORTEST suffix of `base` that `next` begins
 * with. Shortest, not longest: in repetitive text several lengths match, and the longest
 * silently eats real characters. Erring short leaves a visible duplicate; erring long
 * corrupts the output with no trace.
 */
function stripOverlap(base, next) {
  if (!base || !next) return next;
  const limit = Math.min(base.length, next.length, HEAD_WINDOW);
  for (let n = MIN_OVERLAP; n <= limit; n++) {
    if (next.startsWith(base.slice(base.length - n))) return next.slice(n);
  }
  return next;
}

/** Odd fence count means the answer stopped inside a code block. */
function insideFence(text) {
  return ((text.match(/```/g) || []).length % 2) === 1;
}

function stripPreamble(text, inFence) {
  const trimmed = text.replace(/^\s+/, '');
  const noPreamble = trimmed.replace(
    /^(?:sure|okay|ok|certainly|of course|continuing|continued|here(?:'s| is) the rest)\b[^\n]{0,80}\n+/i,
    '',
  );
  // Only lose leading whitespace if a preamble was really there - a resumed line
  // can legitimately start with a space or newline.
  let out = noPreamble !== trimmed ? noPreamble : text;
  if (inFence) {
    const noFence = out.replace(/^\s*```[a-z0-9+#.-]*\n/i, '');
    if (noFence !== out) out = noFence;
  }
  return out;
}

/**
 * @param callRound  (turns, signal) => AsyncIterable<{type:'text'|'finish', ...}>
 * @param baseTurns  conversation so far, in corp {speaker,utterance} form
 * Yields { type:'text', text } and a final { type:'finish', reason }.
 */
async function* withContinuation(callRound, baseTurns, opts = {}) {
  const cap = opts.maxResponseChars ?? 5000;
  const tolerance = opts.capTolerance ?? 64;
  const maxRounds = opts.maxContinuations ?? 8;
  const log = opts.log ?? (() => {});
  const signal = opts.signal;

  let full = '';
  let round = 0;
  let hitLimit = false;

  for (;;) {
    const base = full;
    let rawLength = 0;
    let finish;
    // Round 0 streams straight through; later rounds buffer a head window to de-dup.
    let head = round === 0 ? null : '';

    const turns = round === 0
      ? baseTurns
      : [...baseTurns,
        { speaker: 'assistant', utterance: full },
        { speaker: 'human', utterance: CONTINUE_INSTRUCTION }];

    for await (const ev of callRound(turns, signal)) {
      if (ev.type === 'finish') {
        finish = ev.reason;
        continue;
      }
      if (!ev.text) continue;
      rawLength += ev.text.length;

      if (head !== null) {
        head += ev.text;
        if (head.length < HEAD_WINDOW) continue;
        const cleaned = stripOverlap(base, stripPreamble(head, insideFence(base)));
        head = null;
        if (cleaned) {
          full += cleaned;
          yield { type: 'text', text: cleaned };
        }
        continue;
      }

      full += ev.text;
      yield { type: 'text', text: ev.text };
    }

    if (head !== null && head) {
      const cleaned = stripOverlap(base, stripPreamble(head, insideFence(base)));
      if (cleaned) {
        full += cleaned;
        yield { type: 'text', text: cleaned };
      }
    }

    // A continuation that added nothing means there is no more to say.
    if (round > 0 && full.length === base.length) break;

    // Trust an explicit stop reason; only measure length when told nothing.
    const truncated = finish === 'length'
      || (finish == null && cap > 0 && rawLength >= cap - tolerance);

    /**
     * ...unless the answer is provably unfinished.
     *
     * A backend is free to report a clean stop for a response it cut at the cap,
     * and some do. That is harmless in prose - a sentence ends early - but fatal
     * for a tool call: the JSON stops mid-string, nothing can parse it, and the
     * call is rendered into the chat as markup while the file it was supposed to
     * write never appears. An unclosed tool call is not an opinion about whether
     * the model was done, it is evidence that it was not.
     */
    const unfinished = Boolean(opts.needsMore?.(full));
    if (!truncated && !unfinished) break;
    if (!truncated && unfinished) log('the answer stopped inside an unfinished tool call, continuing');

    if (++round > maxRounds) {
      hitLimit = true;
      break;
    }
    log(`hit the ${cap}-char cap, continuing (round ${round})`);
  }

  if (hitLimit) {
    log(`stopped after ${maxRounds} continuations - raise ellm.maxContinuations`
      + `${opts.needsMore?.(full) ? '. The tool call is STILL unfinished, so it cannot run.' : ''}`);
  }
  yield { type: 'finish', reason: 'stop', text: full };
}

module.exports = { withContinuation, stripOverlap, stripPreamble, insideFence, CONTINUE_INSTRUCTION };
