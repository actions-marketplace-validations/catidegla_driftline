import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  logGamma, chiSquareP, gTest, controlChart, benjaminiHochberg, totalVariation,
} from '../src/statistics.mjs';

const near = (actual, expected, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not within ${tolerance} of ${expected}`);

/* ----------------------------------------------------------- the gamma bits */

test('log gamma matches the factorials it generalises', () => {
  near(logGamma(5), Math.log(24));
  near(logGamma(6), Math.log(120));
  near(logGamma(1), 0);
});

test('log gamma matches the reflection case', () => {
  // Below 0.5 the implementation takes a different branch, so the half
  // integer is the one worth pinning.
  near(logGamma(0.5), Math.log(Math.sqrt(Math.PI)));
  near(logGamma(0.25), 1.288022, 1e-5);
});

test('chi square p-values match the published critical values', () => {
  // These are the numbers in the back of every statistics textbook. If this
  // test fails, every p-value the tool prints is wrong, so it is the first
  // thing to check rather than the last.
  near(chiSquareP(3.8415, 1), 0.05);
  near(chiSquareP(6.6349, 1), 0.01);
  near(chiSquareP(5.9915, 2), 0.05);
  near(chiSquareP(11.0705, 5), 0.05);
  near(chiSquareP(18.3070, 10), 0.05);
});

test('a zero statistic is never surprising and a negative one is refused', () => {
  assert.equal(chiSquareP(0, 3), 1);
  assert.equal(chiSquareP(-1, 3), 1);
  assert.equal(chiSquareP(5, 0), 1);
});

/* -------------------------------------------------------------- the G test */

test('identical distributions are not evidence of anything', () => {
  const result = gTest({ a: 18, b: 2 }, { a: 18, b: 2 });

  assert.equal(result.statistic, 0);
  near(result.p, 1);
});

test('a complete flip is as certain as this test gets', () => {
  const result = gTest({ a: 20 }, { b: 20 });

  assert.ok(result.p < 1e-6, `p was ${result.p}`);
  assert.equal(totalVariation({ a: 20 }, { b: 20 }), 1);
});

test('one sample moving in the tail is not an alarm', () => {
  // Nineteen-one against eighteen-two is exactly the sort of wobble that a
  // naive diff would report every morning.
  const result = gTest({ a: 19, b: 1 }, { a: 18, b: 2 });

  assert.ok(result.p > 0.3, `p was ${result.p}`);
});

test('a category present on one side only still counts', () => {
  // The whole signal in a drift check is often a response that used to appear
  // and stopped. Dropping absent categories would hide it.
  const result = gTest({ a: 15, b: 5 }, { a: 20 });

  assert.equal(result.categories, 2);
  assert.ok(result.p < 0.05, `p was ${result.p}`);
});

test('a single category on both sides has no table to test', () => {
  const result = gTest({ a: 20 }, { a: 20 });

  assert.equal(result.comparable, false);
  assert.equal(result.p, 1);
});

test('an empty side is not comparable rather than infinitely different', () => {
  assert.equal(gTest({}, { a: 5 }).comparable, false);
  assert.equal(gTest({ a: 5 }, {}).comparable, false);
});

test('degrees of freedom follow the category count', () => {
  assert.equal(gTest({ a: 5, b: 5, c: 5 }, { a: 5, b: 5, c: 5 }).df, 2);
});

/* --------------------------------------------------------- the control chart */

test('a value inside the band is not flagged', () => {
  const chart = controlChart([10, 10.1, 9.9, 10.05, 9.95], 10.02);

  assert.equal(chart.out, false);
  assert.ok(Math.abs(chart.z) < 3);
});

test('a value outside the band is flagged with its distance', () => {
  const chart = controlChart([10, 10.1, 9.9, 10.05, 9.95], 12);

  assert.equal(chart.out, true);
  assert.ok(chart.z > 3);
});

test('a window that never varied treats any change as out of band', () => {
  // With no observed variation there is no evidence about what normal looks
  // like, so only an exact match can be called unremarkable.
  const flat = controlChart([1, 1, 1, 1], 1);
  assert.equal(flat.out, false);
  assert.equal(flat.z, 0);

  const moved = controlChart([1, 1, 1, 1], 0.9);
  assert.equal(moved.out, true);
  assert.equal(moved.z, Infinity);
});

test('one point is not a window', () => {
  assert.equal(controlChart([5], 9).comparable, false);
  assert.equal(controlChart([], 9).comparable, false);
});

test('the standard deviation is the sample one, not the population one', () => {
  // n-1 rather than n, because the window is a sample of the process. The
  // difference matters most at the small window sizes this tool runs at.
  const chart = controlChart([2, 4, 4, 4, 5, 5, 7, 9], 5);

  near(chart.mean, 5);
  near(chart.sd, 2.13809, 1e-4);
});

/* ------------------------------------------------------- multiple comparisons */

test('benjamini hochberg reproduces the worked example', () => {
  const out = benjaminiHochberg(
    [{ p: 0.001 }, { p: 0.008 }, { p: 0.039 }, { p: 0.041 }, { p: 0.9 }],
    { fdr: 0.05 },
  );

  assert.deepEqual(out.map((x) => x.significant), [true, true, false, false, false]);
  near(out[0].adjusted, 0.005, 1e-4);
  near(out[1].adjusted, 0.02, 1e-4);
  near(out[4].adjusted, 0.9, 1e-4);
});

test('adjusted p-values never decrease as raw ones increase', () => {
  const out = benjaminiHochberg([{ p: 0.01 }, { p: 0.02 }, { p: 0.03 }, { p: 0.04 }]);
  const adjusted = out.map((x) => x.adjusted);

  for (let i = 1; i < adjusted.length; i++) {
    assert.ok(adjusted[i] >= adjusted[i - 1] - 1e-12, `${adjusted[i]} came back below ${adjusted[i - 1]}`);
  }
});

test('the correction is what stops thirty probes crying wolf', () => {
  // Thirty probes on a provider that never changed, p-values spread evenly.
  // Uncorrected, one or two land below 0.05 and the tool reports drift every
  // single morning until somebody deletes the job.
  const spread = Array.from({ length: 30 }, (_, i) => ({ p: (i + 1) / 30 }));

  const naive = spread.filter((x) => x.p < 0.05).length;
  const corrected = benjaminiHochberg(spread, { fdr: 0.05 }).filter((x) => x.significant).length;

  assert.equal(naive, 1);
  assert.equal(corrected, 0);
});

test('a genuine signal survives the correction', () => {
  const withReal = [
    { p: 1e-9 }, ...Array.from({ length: 29 }, (_, i) => ({ p: (i + 1) / 30 })),
  ];

  assert.equal(benjaminiHochberg(withReal, { fdr: 0.05 })[0].significant, true);
});

test('nothing to correct is handled rather than divided by zero', () => {
  assert.deepEqual(benjaminiHochberg([]), []);
  assert.equal(benjaminiHochberg([{ p: NaN }])[0].significant, false);
});

/* ------------------------------------------------------------- effect size */

test('total variation is zero for identical and one for disjoint', () => {
  assert.equal(totalVariation({ a: 5, b: 5 }, { a: 5, b: 5 }), 0);
  assert.equal(totalVariation({ a: 10 }, { b: 10 }), 1);
});

test('total variation ignores sample size, unlike the p-value', () => {
  // The same proportional shift measured with ten samples and a thousand. The
  // p-value differs enormously between these; the effect size must not.
  near(totalVariation({ a: 8, b: 2 }, { a: 5, b: 5 }), 0.3);
  near(totalVariation({ a: 800, b: 200 }, { a: 500, b: 500 }), 0.3);
});

test('a large sample makes a trivial shift certain, which is why effect size is reported', () => {
  const tiny = gTest({ a: 5000, b: 5000 }, { a: 5150, b: 4850 });

  assert.ok(tiny.p < 0.05, 'statistically certain');
  assert.ok(totalVariation({ a: 5000, b: 5000 }, { a: 5150, b: 4850 }) < 0.02, 'and worth nobody waking up for');
});
