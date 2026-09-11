/**
 * Deciding whether the model moved, and saying how sure that is.
 *
 * Three kinds of answer come out of here and they are not the same thing:
 *
 *   proof         the provider reported a different model identity
 *   evidence      the provider said nothing, and the outputs moved further
 *                 than this probe's own noise explains
 *   inconclusive  there is nothing to compare against, or the question itself
 *                 changed, or the run was too broken to read
 *
 * Keeping them apart is most of the value. A tool that collapses them into a
 * boolean will eventually tell somebody their model changed when what really
 * happened is that a rate limit shortened the sample, and after that nobody
 * believes the next alert either.
 */

import { gTest, controlChart, benjaminiHochberg, totalVariation } from './statistics.mjs';
import { compareIdentity, describeIdentity, hasIdentitySignal } from './identity.mjs';
import { mode } from './fingerprint.mjs';

export const DEFAULT_FDR = 0.05;
export const DEFAULT_MIN_EFFECT = 0.15;

/**
 * Assess one probe against its own past.
 *
 * `minEffect` is the reason this is usable at large sample counts. With two
 * hundred samples a half-percent shift is statistically certain and worth
 * nobody's morning, so a change has to be both real and large enough to
 * matter. Significance without an effect size is how a monitor becomes noise.
 */
export function assessProbe({ current, baseline, window = [], minEffect = DEFAULT_MIN_EFFECT, sigma = 3 }) {
  const base = {
    probeId: current.probeId,
    provider: current.provider,
    model: current.model,
    strategy: current.strategy,
    samples: current.samples,
    mode: mode(current.counts),
    errors: current.errors ?? 0,
  };

  if (current.errors && current.errors >= current.samples) {
    return {
      ...base,
      status: 'inconclusive',
      reason: 'every request for this probe failed, so there is no sample to compare',
      p: null,
    };
  }

  if (!baseline) {
    return {
      ...base,
      status: 'inconclusive',
      reason: 'no earlier run of this probe under this label, so this run becomes the baseline',
      p: null,
      firstRun: true,
    };
  }

  if (baseline.probeHash !== current.probeHash) {
    // Refusing rather than comparing. A changed question producing a changed
    // answer is not drift, and reporting it as drift would train the reader to
    // dismiss the real thing.
    return {
      ...base,
      status: 'inconclusive',
      reason: 'the probe itself changed since the baseline, so its history does not describe this question',
      p: null,
      probeChanged: true,
    };
  }

  const identity = compareIdentity(baseline.identity, current.identity);
  const identityNote = describeIdentity(identity);

  const test = gTest(baseline.counts, current.counts);
  const effect = totalVariation(baseline.counts, current.counts);

  // A second, independent view: how dominant the modal answer has been over
  // the window, and whether today sits outside that band. It catches the slow
  // slide that a pairwise test against yesterday never sees, because yesterday
  // was only slightly different from the day before, and so was every day.
  const shares = window
    .filter((o) => o.probeHash === current.probeHash)
    .map((o) => mode(o.counts).share);
  const chart = controlChart(shares, base.mode.share, { sigma });

  if (identity.proof) {
    return {
      ...base,
      status: 'drifted',
      confidence: 'proof',
      reason: identityNote,
      identity,
      p: test.p,
      effect,
      chart,
    };
  }

  const significant = test.comparable && test.p < 1; // provisional; FDR decides
  const large = effect >= minEffect;

  return {
    ...base,
    status: 'candidate',
    confidence: 'evidence',
    identity,
    identityNote,
    p: test.comparable ? test.p : null,
    statistic: test.statistic,
    df: test.df,
    effect,
    large,
    significant,
    chart,
    comparable: test.comparable,
    baselineRunId: baseline.runId,
    baselineAt: baseline.startedAt,
  };
}

/**
 * Apply the across-probe correction and settle every candidate.
 *
 * Done here rather than per probe because false discovery rate is a property
 * of the whole run. Thirty probes each tested at five percent produce about
 * one and a half false alarms every morning on a provider that never changed,
 * and the tool would be uninstalled inside a fortnight.
 */
export function settle(assessments, { fdr = DEFAULT_FDR, minEffect = DEFAULT_MIN_EFFECT } = {}) {
  const candidates = assessments.filter((a) => a.status === 'candidate' && a.comparable);

  const corrected = benjaminiHochberg(candidates.map((c) => ({ p: c.p })), { fdr });

  const byIndex = new Map();
  candidates.forEach((c, i) => byIndex.set(c.probeId, corrected[i]));

  return assessments.map((a) => {
    if (a.status !== 'candidate') return a;

    const c = byIndex.get(a.probeId);

    if (!c) {
      return {
        ...a,
        status: 'inconclusive',
        reason: 'every sample produced the same single answer on both sides, so there is no distribution to test',
      };
    }

    const drifted = c.significant && a.effect >= minEffect;

    return {
      ...a,
      adjusted: c.adjusted,
      status: drifted ? 'drifted' : 'stable',
      reason: drifted
        ? `the answer distribution moved by ${(a.effect * 100).toFixed(0)} percent, ` +
          `further than this probe's own noise explains (adjusted p ${c.adjusted.toExponential(1)})`
        : c.significant
          ? `the shift is real but small, ${(a.effect * 100).toFixed(0)} percent, below the ${(minEffect * 100).toFixed(0)} percent worth reporting`
          : 'within this probe\'s own run-to-run variation',
    };
  });
}

/** Roll the settled probes up into one answer for a CI exit code. */
export function summarise(assessments) {
  const drifted = assessments.filter((a) => a.status === 'drifted');
  const stable = assessments.filter((a) => a.status === 'stable');
  const inconclusive = assessments.filter((a) => a.status === 'inconclusive');
  const proven = drifted.filter((a) => a.confidence === 'proof');
  const slid = assessments.filter((a) => a.status !== 'drifted' && a.chart?.out);

  // Said separately because it changes what the reader should trust below.
  const blind = assessments.filter((a) => a.identity && !hasIdentitySignal(a.identity?.after));

  return {
    drifted: drifted.length,
    proven: proven.length,
    stable: stable.length,
    inconclusive: inconclusive.length,
    sliding: slid.length,
    total: assessments.length,
    clean: drifted.length === 0,
    headline: drifted.length === 0
      ? (stable.length ? `${stable.length} probe(s) held` : 'nothing comparable yet')
      : proven.length
        ? `${drifted.length} probe(s) drifted, ${proven.length} confirmed by the provider itself`
        : `${drifted.length} probe(s) drifted`,
    blind: blind.length,
  };
}
