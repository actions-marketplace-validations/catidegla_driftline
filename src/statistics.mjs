/**
 * The tests that decide whether a model moved under you.
 *
 * This is the part that separates a canary from a threshold. A threshold asks
 * "is this output different", which for anything above temperature 0 is yes,
 * always, and the check gets switched off in a week. The question that can
 * actually be answered is narrower and statistical: given the sampling noise
 * this probe showed at baseline, is today's sample plausibly from the same
 * distribution?
 *
 * Everything here is implemented rather than imported, because a canary that
 * pulls in a stats library pulls in a supply chain, and the whole point is to
 * be the thing you trust when nothing else is behaving.
 */

/* ------------------------------------------------------- the gamma family */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Log gamma, Lanczos approximation. Accurate to about 15 digits for x > 0. */
export function logGamma(x) {
  if (x < 0.5) {
    // Reflection, so the approximation only ever runs on the easy half.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }

  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;

  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i + 1);

  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularized lower incomplete gamma P(a, x), by series expansion.
 *
 * Converges quickly for x < a + 1 and slowly outside it, which is why the
 * caller below picks between this and the continued fraction rather than
 * trusting one everywhere.
 */
function gammaSeries(a, x) {
  if (x <= 0) return 0;

  let ap = a;
  let sum = 1 / a;
  let del = sum;

  for (let n = 0; n < 500; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
  }

  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Regularized upper incomplete gamma Q(a, x), by continued fraction. */
function gammaContinuedFraction(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;

  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }

  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/**
 * The chi-square survival function: P(X > statistic) with df degrees of freedom.
 *
 * This is the p-value for every test below, so it is worth saying what it
 * means and does not. It is the probability of seeing a difference at least
 * this large if nothing changed. A small value says "nothing changed" fits
 * badly. It never says how much changed, and it never says the change matters.
 */
export function chiSquareP(statistic, df) {
  if (!(statistic >= 0) || !(df > 0)) return 1;
  if (statistic === 0) return 1;

  const a = df / 2;
  const x = statistic / 2;

  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/* ------------------------------------------------------------- the tests */

/**
 * G-test of independence on two samples of categorical outputs.
 *
 * Chosen over Pearson's chi-square because probe outputs are sparse by nature:
 * one dominant response and a long tail of rare ones. Chi-square is unreliable
 * when expected counts fall below five, which for a tail category is most of
 * them, while the likelihood ratio degrades more gracefully.
 *
 * Categories absent from one side are still counted, because a response that
 * appeared twenty times at baseline and never today is the entire signal, and
 * dropping it would hide exactly the case this tool exists for.
 *
 * @param {Record<string, number>} baseline  fingerprint -> count
 * @param {Record<string, number>} current   fingerprint -> count
 */
export function gTest(baseline, current) {
  const categories = [...new Set([...Object.keys(baseline), ...Object.keys(current)])];

  const rowA = categories.map((c) => baseline[c] ?? 0);
  const rowB = categories.map((c) => current[c] ?? 0);
  const totalA = rowA.reduce((s, n) => s + n, 0);
  const totalB = rowB.reduce((s, n) => s + n, 0);
  const grand = totalA + totalB;

  if (grand === 0 || totalA === 0 || totalB === 0) {
    return { statistic: 0, df: 0, p: 1, categories: categories.length, comparable: false };
  }

  // A single category on both sides means nothing varied anywhere. There is
  // no table to test, and reporting p = 1 is the honest answer rather than a
  // division by zero dressed up as certainty.
  if (categories.length < 2) {
    return { statistic: 0, df: 0, p: 1, categories: 1, comparable: false };
  }

  let g = 0;

  for (let i = 0; i < categories.length; i++) {
    const columnTotal = rowA[i] + rowB[i];

    for (const [observed, total] of [[rowA[i], totalA], [rowB[i], totalB]]) {
      if (observed === 0) continue; // 0 * log(0) is 0, and log(0) is not.
      const expected = (columnTotal * total) / grand;
      g += observed * Math.log(observed / expected);
    }
  }

  g *= 2;

  const df = categories.length - 1;

  return { statistic: g, df, p: chiSquareP(g, df), categories: categories.length, comparable: true };
}

/**
 * A control chart on a numeric series, which is the right shape for a metric
 * whose level means nothing and whose movement means everything.
 *
 * Returns the z-score of the current value against the baseline window and
 * whether it fell outside the band. Three sigma by default, the usual SPC
 * choice: on a stable process it fires about three times in a thousand.
 *
 * A window that never varied gets a zero standard deviation, which would make
 * every subsequent value infinitely surprising. Treated as a special case
 * rather than allowed to produce Infinity: with no observed variation there is
 * no evidence about what normal variation looks like, so only an exact match
 * is unremarkable.
 */
export function controlChart(window, value, { sigma = 3 } = {}) {
  const n = window.length;

  if (n < 2) return { mean: window[0] ?? null, sd: null, z: null, out: false, comparable: false };

  const mean = window.reduce((s, v) => s + v, 0) / n;
  // Sample standard deviation: n-1, because the window is a sample of the
  // process rather than the whole of it.
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  if (sd === 0) {
    return { mean, sd: 0, z: value === mean ? 0 : Infinity, out: value !== mean, comparable: true };
  }

  const z = (value - mean) / sd;

  return { mean, sd, z, out: Math.abs(z) > sigma, comparable: true };
}

/**
 * Benjamini-Hochberg, controlling the false discovery rate across probes.
 *
 * Without this the tool is unusable at any real size. Thirty probes tested at
 * p < 0.05 produce roughly one and a half false alarms per run on a provider
 * that never changed, and a canary that cries wolf every morning is worse than
 * no canary, because people stop reading it and then miss the real one.
 *
 * BH rather than Bonferroni because the alternative is the opposite failure:
 * Bonferroni at thirty probes demands p < 0.0017 each, which hides genuine
 * drift in all but the most violent cases. BH controls the share of alarms
 * that are false rather than the chance of any false alarm at all, which is
 * the thing somebody reading a morning report actually cares about.
 *
 * @param {Array<{p: number}>} items
 * @returns the same items with `significant` and `adjusted` set
 */
export function benjaminiHochberg(items, { fdr = 0.05 } = {}) {
  const ordered = items
    .map((item, index) => ({ item, index, p: item.p }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);

  const m = ordered.length;
  if (m === 0) return items.map((item) => ({ ...item, significant: false, adjusted: 1 }));

  // Largest k where p(k) <= (k/m) * fdr. Everything at or below it is called.
  let cutoff = -1;
  for (let k = 0; k < m; k++) {
    if (ordered[k].p <= ((k + 1) / m) * fdr) cutoff = k;
  }

  // Adjusted p-values, enforced monotone from the top down so a larger raw
  // p-value can never come back smaller than one beneath it.
  const adjusted = new Array(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    running = Math.min(running, (ordered[k].p * m) / (k + 1));
    adjusted[k] = running;
  }

  const out = items.map((item) => ({ ...item, significant: false, adjusted: 1 }));

  ordered.forEach((entry, k) => {
    out[entry.index] = {
      ...out[entry.index],
      significant: k <= cutoff,
      adjusted: adjusted[k],
    };
  });

  return out;
}

/**
 * How far apart two categorical distributions are, on a 0 to 1 scale.
 *
 * Total variation distance, reported alongside every p-value because the two
 * answer different questions and people reliably conflate them. The p-value
 * says whether the difference is real. This says whether it is large. A
 * thousand samples will find a statistically certain change of half a percent,
 * which is real and almost never worth waking somebody for.
 */
export function totalVariation(baseline, current) {
  const categories = [...new Set([...Object.keys(baseline), ...Object.keys(current)])];
  const totalA = Object.values(baseline).reduce((s, n) => s + n, 0) || 1;
  const totalB = Object.values(current).reduce((s, n) => s + n, 0) || 1;

  let sum = 0;
  for (const c of categories) {
    sum += Math.abs((baseline[c] ?? 0) / totalA - (current[c] ?? 0) / totalB);
  }

  return sum / 2;
}
