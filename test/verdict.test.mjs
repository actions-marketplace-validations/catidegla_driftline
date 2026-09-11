import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessProbe, settle, summarise } from '../src/verdict.mjs';
import { captureIdentity } from '../src/identity.mjs';

const observation = (counts, extra = {}) => ({
  probeId: 'p', probeHash: 'h1', provider: 'anthropic', model: 'm',
  strategy: 'exact', samples: Object.values(counts).reduce((s, n) => s + n, 0),
  counts, errors: 0, identity: captureIdentity({ model: 'm' }), ...extra,
});

const settleOne = (assessment) => settle([assessment])[0];

/* ------------------------------------------------------------ the easy cases */

test('a first run has nothing to compare and says so', () => {
  const a = assessProbe({ current: observation({ x: 20 }), baseline: null });

  assert.equal(a.status, 'inconclusive');
  assert.equal(a.firstRun, true);
  assert.match(a.reason, /becomes the baseline/);
});

test('a changed probe refuses to compare rather than reporting drift', () => {
  // A different question producing a different answer is not drift, and
  // calling it drift would teach the reader to dismiss the real thing.
  const a = assessProbe({
    current: observation({ x: 20 }),
    baseline: { ...observation({ y: 20 }), probeHash: 'h2', runId: 1 },
  });

  assert.equal(a.status, 'inconclusive');
  assert.equal(a.probeChanged, true);
});

test('a probe whose every request failed is unreadable, not changed', () => {
  const a = assessProbe({
    current: observation({}, { errors: 20, samples: 20 }),
    baseline: { ...observation({ x: 20 }), runId: 1 },
  });

  assert.equal(a.status, 'inconclusive');
  assert.match(a.reason, /every request/);
});

/* ------------------------------------------------------------------- proof */

test('a reported identity change is proof and short-circuits the statistics', () => {
  const a = assessProbe({
    current: observation({ x: 20 }, { identity: captureIdentity({ system_fingerprint: 'fp_new' }) }),
    baseline: { ...observation({ x: 20 }, { identity: captureIdentity({ system_fingerprint: 'fp_old' }) }), runId: 1 },
  });

  assert.equal(a.status, 'drifted');
  assert.equal(a.confidence, 'proof');
  // The outputs were identical. Without the identity capture this run reads
  // as perfectly stable, which is exactly the blind spot being covered.
  assert.match(a.reason, /different system_fingerprint/);
});

/* ---------------------------------------------------------------- evidence */

test('an unchanged distribution settles as stable', () => {
  const a = settleOne(assessProbe({
    current: observation({ x: 18, y: 2 }),
    baseline: { ...observation({ x: 18, y: 2 }), runId: 1 },
  }));

  assert.equal(a.status, 'stable');
});

test('a wholesale change settles as drifted', () => {
  const a = settleOne(assessProbe({
    current: observation({ y: 20 }),
    baseline: { ...observation({ x: 20 }), runId: 1 },
  }));

  assert.equal(a.status, 'drifted');
  assert.equal(a.effect, 1);
  assert.match(a.reason, /moved by 100 percent/);
});

test('a real but tiny shift is reported as not worth reporting', () => {
  // Five thousand samples make a three percent shift statistically certain.
  // The effect floor is what stops that becoming an alert.
  const a = settleOne(assessProbe({
    current: observation({ x: 4850, y: 5150 }),
    baseline: { ...observation({ x: 5000, y: 5000 }), runId: 1 },
  }));

  assert.equal(a.status, 'stable');
  assert.match(a.reason, /real but small/);
});

test('the effect floor is the caller\'s to move', () => {
  const args = {
    current: observation({ x: 4850, y: 5150 }),
    baseline: { ...observation({ x: 5000, y: 5000 }), runId: 1 },
  };

  assert.equal(settle([assessProbe({ ...args, minEffect: 0.01 })], { minEffect: 0.01 })[0].status, 'drifted');
});

test('identical single answers on both sides have no distribution to test', () => {
  const a = settleOne(assessProbe({
    current: observation({ x: 20 }),
    baseline: { ...observation({ x: 20 }), runId: 1 },
  }));

  assert.equal(a.status, 'inconclusive');
  assert.match(a.reason, /same single answer/);
});

/* -------------------------------------------------- across the whole run */

test('thirty quiet probes do not produce an alarm between them', () => {
  // The scenario that kills a monitoring tool: a provider that changed
  // nothing, thirty probes, and ordinary sampling noise on each.
  const assessments = Array.from({ length: 30 }, (_, i) => assessProbe({
    current: { ...observation({ x: 17, y: 3 }), probeId: `p${i}` },
    baseline: { ...observation({ x: 18, y: 2 }), probeId: `p${i}`, runId: 1 },
  }));

  const settled = settle(assessments);

  assert.equal(settled.filter((a) => a.status === 'drifted').length, 0);
});

test('one genuine change is still found among twenty-nine quiet ones', () => {
  const assessments = [
    assessProbe({
      current: { ...observation({ y: 20 }), probeId: 'real' },
      baseline: { ...observation({ x: 20 }), probeId: 'real', runId: 1 },
    }),
    ...Array.from({ length: 29 }, (_, i) => assessProbe({
      current: { ...observation({ x: 17, y: 3 }), probeId: `p${i}` },
      baseline: { ...observation({ x: 18, y: 2 }), probeId: `p${i}`, runId: 1 },
    })),
  ];

  const settled = settle(assessments);
  const drifted = settled.filter((a) => a.status === 'drifted');

  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].probeId, 'real');
});

/* ------------------------------------------------------------- slow slides */

test('a slide inside the band is noted without being called drift', () => {
  const window = [0.95, 0.94, 0.95, 0.96, 0.95].map((share) => ({
    ...observation({ x: Math.round(share * 20), y: 20 - Math.round(share * 20) }),
    probeHash: 'h1',
  }));

  const a = settleOne(assessProbe({
    current: observation({ x: 12, y: 8 }),
    baseline: { ...observation({ x: 13, y: 7 }), runId: 1 },
    window,
  }));

  // Against yesterday alone this is unremarkable. Against its own band it is
  // a long way from where this probe has ever sat.
  assert.equal(a.chart.out, true);
  assert.equal(a.status, 'stable');
});

/* --------------------------------------------------------------- summary */

test('the summary counts what a CI job needs to branch on', () => {
  const settled = settle([
    assessProbe({ current: observation({ y: 20 }), baseline: { ...observation({ x: 20 }), runId: 1 } }),
    assessProbe({ current: { ...observation({ x: 18, y: 2 }), probeId: 'q' }, baseline: { ...observation({ x: 18, y: 2 }), probeId: 'q', runId: 1 } }),
    assessProbe({ current: { ...observation({ x: 20 }), probeId: 'r' }, baseline: null }),
  ]);

  const summary = summarise(settled);

  assert.equal(summary.drifted, 1);
  assert.equal(summary.stable, 1);
  assert.equal(summary.inconclusive, 1);
  assert.equal(summary.clean, false);
});

test('a clean run says what held rather than saying nothing', () => {
  const settled = settle([assessProbe({
    current: observation({ x: 18, y: 2 }),
    baseline: { ...observation({ x: 18, y: 2 }), runId: 1 },
  })]);

  const summary = summarise(settled);

  assert.equal(summary.clean, true);
  assert.match(summary.headline, /held/);
});

test('a proven change is called out separately in the headline', () => {
  const settled = settle([assessProbe({
    current: observation({ x: 20 }, { identity: captureIdentity({ system_fingerprint: 'fp_new' }) }),
    baseline: { ...observation({ x: 20 }, { identity: captureIdentity({ system_fingerprint: 'fp_old' }) }), runId: 1 },
  })]);

  assert.match(summarise(settled).headline, /confirmed by the provider itself/);
});
