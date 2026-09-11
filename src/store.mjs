/**
 * The history, in one SQLite file.
 *
 * Local and committed-adjacent rather than shipped to a service. A canary that
 * needs an account is a canary that stops working the week somebody's card
 * expires, and the whole value is in the long tail of runs nobody looked at
 * until the morning they mattered.
 *
 * Two tables and no cleverness. Runs are what happened; observations are what
 * each probe answered, kept as counts rather than raw text so a year of
 * history stays small and no prompt output is ever written to disk unless the
 * operator asks for it.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  git_ref     TEXT,
  probes      INTEGER NOT NULL DEFAULT 0,
  requests    INTEGER NOT NULL DEFAULT 0,
  failures    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS runs_label ON runs(label, started_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  probe_id    TEXT NOT NULL,
  probe_hash  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT,
  strategy    TEXT NOT NULL,
  samples     INTEGER NOT NULL,
  counts      TEXT NOT NULL,
  identity    TEXT,
  usage_in    INTEGER,
  usage_out   INTEGER,
  latency_ms  INTEGER,
  errors      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, probe_id)
);

CREATE INDEX IF NOT EXISTS observations_probe ON observations(probe_id, run_id DESC);
`;

export function open(path = '.driftline/history.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);

  return db;
}

/**
 * Columns added after the first release.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a history file
 * written by an older version keeps its old shape and every read of a new
 * column comes back undefined. Migrating here means somebody's year of runs
 * survives an upgrade, which for this tool is the entire asset.
 */
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));

  // Kept for the next time this is needed, and harmless while empty.
  const additions = [];

  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE observations ADD COLUMN ${name} ${type}`);
  }
}

export function startRun(db, { label, gitRef = null }) {
  const startedAt = new Date().toISOString();

  const result = db
    .prepare('INSERT INTO runs (label, started_at, git_ref) VALUES (?, ?, ?)')
    .run(label, startedAt, gitRef);

  return { id: Number(result.lastInsertRowid), label, startedAt };
}

export function recordObservation(db, runId, observation) {
  db.prepare(`
    INSERT INTO observations
      (run_id, probe_id, probe_hash, provider, model, strategy, samples, counts, identity, usage_in, usage_out, latency_ms, errors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    observation.probeId,
    observation.probeHash,
    observation.provider,
    observation.model ?? null,
    observation.strategy,
    observation.samples,
    JSON.stringify(observation.counts),
    observation.identity ? JSON.stringify(observation.identity) : null,
    observation.usage?.input ?? null,
    observation.usage?.output ?? null,
    observation.latencyMs ?? null,
    observation.errors ?? 0,
  );
}

export function finishRun(db, runId, { probes, requests, failures }) {
  db.prepare('UPDATE runs SET probes = ?, requests = ?, failures = ? WHERE id = ?')
    .run(probes, requests, failures, runId);
}

/**
 * The most recent observation of a probe before this run, under a label.
 *
 * Scoped to the label because a canary run from a feature branch must not
 * become the baseline that main is measured against. The probe hash comes back
 * with it so the caller can refuse a comparison across a changed question.
 */
export function baselineFor(db, { label, probeId, beforeRunId = null }) {
  const row = db.prepare(`
    SELECT o.*, r.started_at, r.git_ref
    FROM observations o
    JOIN runs r ON r.id = o.run_id
    WHERE o.probe_id = ? AND r.label = ? ${beforeRunId ? 'AND o.run_id < ?' : ''}
    ORDER BY o.run_id DESC
    LIMIT 1
  `).get(...(beforeRunId ? [probeId, label, beforeRunId] : [probeId, label]));

  return row ? hydrate(row) : null;
}

/**
 * A window of past observations, oldest first.
 *
 * The control chart needs a window rather than a single predecessor, because
 * one previous run cannot tell you what normal variation looks like and a
 * canary built on a single comparison fires on ordinary noise.
 */
export function windowFor(db, { label, probeId, limit = 20, beforeRunId = null }) {
  const rows = db.prepare(`
    SELECT o.*, r.started_at, r.git_ref
    FROM observations o
    JOIN runs r ON r.id = o.run_id
    WHERE o.probe_id = ? AND r.label = ? ${beforeRunId ? 'AND o.run_id < ?' : ''}
    ORDER BY o.run_id DESC
    LIMIT ?
  `).all(...(beforeRunId ? [probeId, label, beforeRunId, limit] : [probeId, label, limit]));

  return rows.map(hydrate).reverse();
}

export function runs(db, { label = null, limit = 30 } = {}) {
  const rows = label
    ? db.prepare('SELECT * FROM runs WHERE label = ? ORDER BY id DESC LIMIT ?').all(label, limit)
    : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);

  return rows.map((r) => ({
    id: r.id, label: r.label, startedAt: r.started_at, gitRef: r.git_ref,
    probes: r.probes, requests: r.requests, failures: r.failures,
  }));
}

/**
 * Every observation in one run.
 *
 * Joined to runs rather than selected alone, so an observation has the same
 * shape whichever accessor produced it. Without the join the run's timestamp
 * and git ref come back null here and populated everywhere else, which is the
 * kind of inconsistency that gets discovered by a caller rather than a test.
 */
export function observationsFor(db, runId) {
  return db.prepare(`
    SELECT o.*, r.started_at, r.git_ref
    FROM observations o
    JOIN runs r ON r.id = o.run_id
    WHERE o.run_id = ?
    ORDER BY o.probe_id
  `).all(runId).map(hydrate);
}

/** Every observation of one probe, for the timeline. */
export function seriesFor(db, { label, probeId, limit = 120 }) {
  const rows = db.prepare(`
    SELECT o.*, r.started_at, r.git_ref
    FROM observations o
    JOIN runs r ON r.id = o.run_id
    WHERE o.probe_id = ? AND r.label = ?
    ORDER BY o.run_id ASC
    LIMIT ?
  `).all(probeId, label, limit);

  return rows.map(hydrate);
}

function hydrate(row) {
  return {
    runId: row.run_id,
    probeId: row.probe_id,
    probeHash: row.probe_hash,
    provider: row.provider,
    model: row.model,
    strategy: row.strategy,
    samples: row.samples,
    counts: JSON.parse(row.counts),
    identity: row.identity ? JSON.parse(row.identity) : null,
    usage: { input: row.usage_in, output: row.usage_out },
    latencyMs: row.latency_ms,
    errors: row.errors,
    startedAt: row.started_at ?? null,
    gitRef: row.git_ref ?? null,
  };
}
