/**
 * Turning an answer into something countable.
 *
 * The statistics downstream compare distributions over categories, so every
 * output has to become a category. How you draw that line decides what the
 * canary can see, and there is no single right answer: too strict and every
 * run looks like drift because a comma moved, too loose and a model that
 * changed its mind entirely looks stable because the JSON still parses.
 *
 * So the strategy is per probe, declared in the probe file, and the default is
 * the strictest one that still ignores whitespace. A tool that guesses this
 * for you is a tool that will be wrong quietly.
 */

import { createHash } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/* --------------------------------------------------------------- helpers */

/** Collapse runs of whitespace and trim. Never changes what words are there. */
const normaliseSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * A stable key for any JSON value.
 *
 * Object keys sorted, because two providers serialising the same object in a
 * different order is not a change in the answer, and would otherwise show up
 * as one on the day a provider swaps its JSON encoder.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';

  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    .join(',') + '}';
}

/** The shape of a JSON value with every leaf replaced by its type. */
function jsonShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const inner = [...new Set(value.map(jsonShape))].sort();
    return '[' + (inner.join('|') || '') + ']';
  }
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => k + ':' + jsonShape(value[k])).join(',') + '}';
  }
  return typeof value;
}

function parseJsonLoosely(text) {
  const trimmed = String(text ?? '').trim();

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Models wrap JSON in prose and fences constantly. Pulling the outermost
    // braces out is not clever, it is the difference between a JSON strategy
    // that works on real output and one that only works in the README.
    const first = trimmed.search(/[[{]/);
    const last = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));

    if (first === -1 || last <= first) return { ok: false, value: null };

    try {
      return { ok: true, value: JSON.parse(trimmed.slice(first, last + 1)) };
    } catch {
      return { ok: false, value: null };
    }
  }
}

/* ------------------------------------------------------------ strategies */

export const STRATEGIES = {
  /**
   * The whole answer, whitespace normalised. The default.
   *
   * At temperature 0 this is what you want: it will notice a single changed
   * word, which is exactly the sort of thing that moves downstream behaviour
   * and that nobody spots by eye.
   */
  exact: (text) => hash(normaliseSpace(text)),

  /** Case and punctuation folded away, for probes whose answer is a word. */
  lenient: (text) => hash(
    normaliseSpace(text).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ''),
  ),

  /**
   * The parsed value, key order ignored.
   *
   * For probes that ask for structured output. Notices a changed value,
   * ignores a reserialisation.
   */
  json: (text) => {
    const { ok, value } = parseJsonLoosely(text);
    return ok ? hash(canonicalJson(value)) : 'unparseable';
  },

  /**
   * The structure only, values ignored.
   *
   * The one to reach for when the content is legitimately free to vary but the
   * contract is not. A schema that gains a field or loses one shows up; a
   * different sentence inside the same field does not.
   */
  shape: (text) => {
    const { ok, value } = parseJsonLoosely(text);
    return ok ? hash(jsonShape(value)) : 'unparseable';
  },

  /**
   * The first line only.
   *
   * Useful where a model answers then explains itself, and the explanation is
   * free to vary while the answer is not.
   */
  first_line: (text) => hash(normaliseSpace(String(text ?? '').split('\n')[0])),

  /**
   * Refusal or not, and nothing else.
   *
   * A coarse category on purpose. Providers retune safety behaviour far more
   * often than they retune anything else, and a probe watching for it wants to
   * know that the model started declining, not which words it declined with.
   */
  refusal: (text) => (looksLikeRefusal(text) ? 'refused' : 'answered'),
};

/**
 * Refusal detection, deliberately conservative.
 *
 * Matching on surface phrases is a blunt instrument and will miss a polite
 * deflection that never says "cannot". It is still worth having, because the
 * failure mode is one-sided: a missed refusal shows up in the exact strategy
 * on the same probe, while a false positive would turn every apologetic answer
 * into a category change.
 */
export function looksLikeRefusal(text) {
  const t = normaliseSpace(text).toLowerCase();
  if (t === '') return false;

  // Anchored near the start, because "I cannot" opening an answer is a
  // refusal while the same words in paragraph four are usually content.
  const opening = t.slice(0, 160);

  return [
    /\bi (?:can(?:'|’)?t|cannot|won(?:'|’)?t|am unable to|am not able to)\b/,
    /\bi(?:'|’)?m (?:sorry|afraid)\b/,
    /\b(?:i (?:will|do) not|i must decline)\b/,
    /\bas an ai\b/,
    /\bthat(?:'|’)?s not something i (?:can|will)\b/,
  ].some((re) => re.test(opening));
}

/* ----------------------------------------------------------------- facade */

export const DEFAULT_STRATEGY = 'exact';

/**
 * Fingerprint one answer under a named strategy.
 *
 * An unknown strategy throws rather than silently falling back, because a
 * typo in a probe file would otherwise change what the canary watches without
 * telling anyone, and a canary that quietly watches the wrong thing is worse
 * than one that is switched off.
 */
export function fingerprint(text, strategy = DEFAULT_STRATEGY) {
  const fn = STRATEGIES[strategy];

  if (!fn) {
    throw new Error(
      `unknown fingerprint strategy "${strategy}". Available: ${Object.keys(STRATEGIES).join(', ')}`,
    );
  }

  return fn(text);
}

/**
 * Count fingerprints across a sample.
 *
 * @param {string[]} outputs
 * @returns {Record<string, number>} fingerprint -> count
 */
export function tally(outputs, strategy = DEFAULT_STRATEGY) {
  const counts = {};

  for (const output of outputs) {
    const key = fingerprint(output, strategy);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

/**
 * The most common answer and how dominant it was.
 *
 * Reported next to every probe because it is the number a human reads first.
 * "The modal answer held at 20 of 20" and "it held at 11 of 20" are both
 * stable by a p-value and mean very different things about the probe.
 */
export function mode(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return { fingerprint: null, count: 0, share: 0 };

  const total = entries.reduce((s, [, n]) => s + n, 0);
  const [fp, count] = entries.reduce((best, e) => (e[1] > best[1] ? e : best));

  return { fingerprint: fp, count, share: count / total };
}
