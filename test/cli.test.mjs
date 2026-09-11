import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from '../src/store.mjs';

const exec = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'driftline.mjs');

/**
 * Nothing in here calls a provider.
 *
 * The commands that would are covered against a fake transport in
 * run.test.mjs. A CI suite that spent money on every commit would be switched
 * off, and one that depended on a vendor being up would go red for reasons
 * that have nothing to do with the change under test.
 */
async function run(args, cwd) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'driftline-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('version and help answer without touching anything', async () => {
  await sandbox(async (dir) => {
    const version = await run(['--version'], dir);
    assert.equal(version.code, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const help = await run([], dir);
    assert.match(help.stdout, /Watch for the day your provider changes/);
  });
});

test('an unknown command exits with the usage code, not the drift code', async () => {
  // A typo must never look like a passing or failing check to CI.
  await sandbox(async (dir) => {
    const result = await run(['wat'], dir);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown command/);
  });
});

test('init writes probes that then validate', async () => {
  await sandbox(async (dir) => {
    const init = await run(['init'], dir);
    assert.equal(init.code, 0);

    const probes = await run(['probes'], dir);
    assert.equal(probes.code, 0);
    assert.match(probes.stdout, /probe\(s\) in probes.jsonl/);
    assert.match(probes.stdout, /requests per run/);
  });
});

test('probes prints the recurring cost before anything is sent', async () => {
  await sandbox(async (dir) => {
    await writeFile(join(dir, 'probes.jsonl'), [
      JSON.stringify({ id: 'a', provider: 'anthropic', prompt: 'x', samples: 10 }),
      JSON.stringify({ id: 'b', provider: 'anthropic', prompt: 'y', samples: 15 }),
    ].join('\n'));

    const result = await run(['probes', '--json'], dir);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.requests, 25);
  });
});

test('a broken probe file exits 2 and names every problem with its line', async () => {
  await sandbox(async (dir) => {
    await writeFile(join(dir, 'probes.jsonl'), [
      JSON.stringify({ id: 'a' }),
      JSON.stringify({ id: 'b', provider: 'nope', prompt: 'x' }),
    ].join('\n'));

    const result = await run(['probes'], dir);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /:1/);
    assert.match(result.stderr, /:2/);
  });
});

test('only selects a subset and refuses a name that matches nothing', async () => {
  await sandbox(async (dir) => {
    await run(['init'], dir);

    const one = await run(['probes', '--json', '--only', 'json-contract'], dir);
    assert.equal(JSON.parse(one.stdout).probes.length, 1);

    const none = await run(['probes', '--only', 'nonexistent'], dir);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /matched no probe/);
  });
});

test('history is empty rather than broken before the first run', async () => {
  await sandbox(async (dir) => {
    const result = await run(['history'], dir);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /No runs recorded yet/);
  });
});

test('history reads back what the store recorded', async () => {
  await sandbox(async (dir) => {
    const db = store.open(join(dir, 'h.db'));
    const created = store.startRun(db, { label: 'main', gitRef: 'deadbee' });
    store.recordObservation(db, created.id, {
      probeId: 'p', probeHash: 'h', provider: 'anthropic', model: 'm', strategy: 'exact',
      samples: 4, counts: { x: 4 }, identity: null, usage: {}, latencyMs: 1, errors: 0,
    });
    store.finishRun(db, created.id, { probes: 1, requests: 4, failures: 0 });
    db.close();

    const result = await run(['history', '--db', 'h.db', '--json'], dir);
    const runs = JSON.parse(result.stdout);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].requests, 4);
    assert.equal(runs[0].gitRef, 'deadbee');
  });
});

test('the timeline renders an SVG with no script and no dependency', async () => {
  await sandbox(async (dir) => {
    const db = store.open(join(dir, 'h.db'));

    for (const counts of [{ x: 10 }, { x: 7, y: 3 }, { y: 10 }]) {
      const created = store.startRun(db, { label: 'main' });
      store.recordObservation(db, created.id, {
        probeId: 'p', probeHash: 'h', provider: 'anthropic', model: 'm', strategy: 'exact',
        samples: 10, counts, identity: null, usage: {}, latencyMs: 1, errors: 0,
      });
      store.finishRun(db, created.id, { probes: 1, requests: 10, failures: 0 });
    }
    db.close();

    const result = await run(['timeline', '--db', 'h.db', '--svg', 'out.svg'], dir);
    assert.equal(result.code, 0);

    const svg = await readFile(join(dir, 'out.svg'), 'utf8');

    assert.match(svg, /^<svg /);
    assert.ok(!/<script/i.test(svg), 'an SVG pasted into a pull request must carry no script');
    assert.match(svg, /<path/);
  });
});

test('a timeline with nothing to draw says so rather than rendering an empty box', async () => {
  await sandbox(async (dir) => {
    const result = await run(['timeline', '--db', 'h.db', '--svg', 'out.svg'], dir);

    assert.equal(result.code, 0);
    assert.match(await readFile(join(dir, 'out.svg'), 'utf8'), /Not enough history/);
  });
});
