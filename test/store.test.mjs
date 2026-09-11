import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../src/store.mjs';

const observation = (probeId, counts, extra = {}) => ({
  probeId, probeHash: 'h1', provider: 'anthropic', model: 'm', strategy: 'exact',
  samples: Object.values(counts).reduce((s, n) => s + n, 0), counts,
  identity: { reported: { model: 'm' }, headers: {} }, usage: { input: 1, output: 2 },
  latencyMs: 10, errors: 0, ...extra,
});

function seed(db, label, rows) {
  const ids = [];
  for (const counts of rows) {
    const run = store.startRun(db, { label });
    store.recordObservation(db, run.id, observation('p', counts));
    store.finishRun(db, run.id, { probes: 1, requests: 10, failures: 0 });
    ids.push(run.id);
  }
  return ids;
}

test('an observation round trips', () => {
  const db = store.open(':memory:');
  const run = store.startRun(db, { label: 'main', gitRef: 'abc1234' });

  store.recordObservation(db, run.id, observation('p', { x: 8, y: 2 }));

  const [back] = store.observationsFor(db, run.id);

  assert.deepEqual(back.counts, { x: 8, y: 2 });
  assert.equal(back.identity.reported.model, 'm');
  assert.equal(back.gitRef, 'abc1234');
  db.close();
});

test('the baseline is the previous run, not this one', () => {
  // Comparing a run against itself would report perfect stability forever.
  const db = store.open(':memory:');
  const [, , third] = seed(db, 'main', [{ x: 10 }, { x: 9, y: 1 }, { y: 10 }]);

  const baseline = store.baselineFor(db, { label: 'main', probeId: 'p', beforeRunId: third });

  assert.deepEqual(baseline.counts, { x: 9, y: 1 });
  db.close();
});

test('labels are separate series', () => {
  // A canary run from a feature branch must never become the baseline main
  // is measured against.
  const db = store.open(':memory:');
  seed(db, 'main', [{ x: 10 }]);
  seed(db, 'pr-42', [{ y: 10 }]);

  assert.deepEqual(store.baselineFor(db, { label: 'main', probeId: 'p' }).counts, { x: 10 });
  assert.deepEqual(store.baselineFor(db, { label: 'pr-42', probeId: 'p' }).counts, { y: 10 });
  db.close();
});

test('no history returns null rather than an empty baseline', () => {
  const db = store.open(':memory:');

  assert.equal(store.baselineFor(db, { label: 'main', probeId: 'nothing' }), null);
  db.close();
});

test('the window comes back oldest first, which is the order a chart wants', () => {
  const db = store.open(':memory:');
  seed(db, 'main', [{ x: 10 }, { x: 9, y: 1 }, { x: 8, y: 2 }]);

  const window = store.windowFor(db, { label: 'main', probeId: 'p', limit: 10 });

  assert.equal(window.length, 3);
  assert.deepEqual(window[0].counts, { x: 10 });
  assert.deepEqual(window.at(-1).counts, { x: 8, y: 2 });
  db.close();
});

test('the window excludes the run being judged', () => {
  const db = store.open(':memory:');
  const ids = seed(db, 'main', [{ x: 10 }, { x: 10 }, { y: 10 }]);

  const window = store.windowFor(db, { label: 'main', probeId: 'p', beforeRunId: ids[2] });

  assert.equal(window.length, 2);
  assert.ok(window.every((o) => o.runId < ids[2]));
  db.close();
});

test('the window is capped, so a year of history does not become the band', () => {
  const db = store.open(':memory:');
  seed(db, 'main', Array.from({ length: 30 }, () => ({ x: 10 })));

  assert.equal(store.windowFor(db, { label: 'main', probeId: 'p', limit: 5 }).length, 5);
  db.close();
});

test('runs list newest first with their counts', () => {
  const db = store.open(':memory:');
  seed(db, 'main', [{ x: 10 }, { x: 10 }]);

  const all = store.runs(db, { label: 'main' });

  assert.equal(all.length, 2);
  assert.ok(all[0].id > all[1].id);
  assert.equal(all[0].requests, 10);
  db.close();
});

test('the series for a probe is the whole timeline, oldest first', () => {
  const db = store.open(':memory:');
  seed(db, 'main', [{ x: 10 }, { x: 5, y: 5 }, { y: 10 }]);

  const series = store.seriesFor(db, { label: 'main', probeId: 'p' });

  assert.equal(series.length, 3);
  assert.deepEqual(series[0].counts, { x: 10 });
  assert.deepEqual(series.at(-1).counts, { y: 10 });
  db.close();
});

test('deleting a run takes its observations with it', () => {
  const db = store.open(':memory:');
  const [id] = seed(db, 'main', [{ x: 10 }]);

  db.prepare('DELETE FROM runs WHERE id = ?').run(id);

  assert.equal(store.observationsFor(db, id).length, 0);
  db.close();
});

test('one probe cannot be recorded twice in the same run', () => {
  // The primary key is what stops a retry from doubling a distribution.
  const db = store.open(':memory:');
  const run = store.startRun(db, { label: 'main' });

  store.recordObservation(db, run.id, observation('p', { x: 5 }));

  assert.throws(() => store.recordObservation(db, run.id, observation('p', { x: 5 })));
  db.close();
});

test('no prompt text is ever written to the history file', () => {
  // Only counts and hashes. A probe may carry a customer support transcript,
  // and a monitoring tool should not become the place it leaks from.
  const db = store.open(':memory:');
  const run = store.startRun(db, { label: 'main' });
  store.recordObservation(db, run.id, observation('p', { abc123: 10 }));

  const columns = db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name);

  assert.ok(!columns.includes('prompt'));
  assert.ok(!columns.includes('output'));
  assert.ok(!columns.includes('text'));
  db.close();
});
