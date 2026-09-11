import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProbes, probeHash, requestCount, byProvider, DEFAULT_SAMPLES } from '../src/probe.mjs';

async function withFile(lines, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'driftline-'));
  const file = join(dir, 'probes.jsonl');
  await writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');

  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const valid = { id: 'a', provider: 'anthropic', prompt: 'hello' };

test('a minimal probe loads with the defaults filled in', async () => {
  await withFile([valid], async (file) => {
    const { probes, problems } = await loadProbes(file);

    assert.deepEqual(problems, []);
    assert.equal(probes[0].temperature, 0);
    assert.equal(probes[0].samples, DEFAULT_SAMPLES);
    assert.equal(probes[0].strategy, 'exact');
    assert.deepEqual(probes[0].messages, [{ role: 'user', content: 'hello' }]);
  });
});

test('every problem is reported in one pass with its line number', async () => {
  await withFile([
    { id: 'a' },
    { provider: 'anthropic', prompt: 'x' },
    { id: 'c', provider: 'nope', prompt: 'x' },
  ], async (file) => {
    const { problems } = await loadProbes(file);

    assert.ok(problems.length >= 3);
    assert.ok(problems.some((p) => p.includes(':1')));
    assert.ok(problems.some((p) => p.includes(':2')));
    assert.ok(problems.some((p) => p.includes(':3')));
  });
});

test('a duplicate id is refused because history joins on it', async () => {
  await withFile([valid, { ...valid, prompt: 'different' }], async (file) => {
    const { problems } = await loadProbes(file);

    assert.ok(problems.some((p) => /repeats the id/.test(p)));
  });
});

test('a probe with neither prompt nor messages is refused', async () => {
  await withFile([{ id: 'a', provider: 'anthropic' }], async (file) => {
    assert.ok((await loadProbes(file)).problems.some((p) => /prompt or a non-empty messages/.test(p)));
  });
});

test('a probe with both is refused, since only one can be the question', async () => {
  await withFile([{ ...valid, messages: [{ role: 'user', content: 'x' }] }], async (file) => {
    assert.ok((await loadProbes(file)).problems.some((p) => /both prompt and messages/.test(p)));
  });
});

test('one sample is refused because one sample has no distribution', async () => {
  await withFile([{ ...valid, samples: 1 }], async (file) => {
    assert.ok((await loadProbes(file)).problems.some((p) => /no distribution/.test(p)));
  });
});

test('an unknown key is refused rather than ignored', async () => {
  // A misspelled "strategry" would otherwise leave the probe watching
  // something other than what its author intended, silently.
  await withFile([{ ...valid, strategry: 'json' }], async (file) => {
    assert.ok((await loadProbes(file)).problems.some((p) => /unknown key/.test(p)));
  });
});

test('an unknown strategy names the ones that exist', async () => {
  await withFile([{ ...valid, strategy: 'exakt' }], async (file) => {
    const { problems } = await loadProbes(file);

    assert.ok(problems.some((p) => /not one of/.test(p) && /exact/.test(p)));
  });
});

test('blank lines and comments are skipped', async () => {
  await withFile(['', '// a note', JSON.stringify(valid), ''], async (file) => {
    const { probes, problems } = await loadProbes(file);

    assert.deepEqual(problems, []);
    assert.equal(probes.length, 1);
  });
});

test('a malformed line is one bad line rather than an unreadable file', async () => {
  await withFile([JSON.stringify(valid), '{not json', JSON.stringify({ ...valid, id: 'b' })], async (file) => {
    const { probes, problems } = await loadProbes(file);

    assert.equal(probes.length, 2);
    assert.equal(problems.length, 1);
  });
});

test('a missing file is a problem rather than a throw', async () => {
  const { probes, problems } = await loadProbes('does-not-exist.jsonl');

  assert.deepEqual(probes, []);
  assert.equal(problems.length, 1);
});

/* ---------------------------------------------------------------- the hash */

test('the hash covers everything that determines the answer', () => {
  const base = { provider: 'anthropic', model: 'm', messages: [{ role: 'user', content: 'a' }], temperature: 0, max_tokens: 512, strategy: 'exact' };

  assert.notEqual(probeHash(base), probeHash({ ...base, messages: [{ role: 'user', content: 'b' }] }));
  assert.notEqual(probeHash(base), probeHash({ ...base, temperature: 1 }));
  assert.notEqual(probeHash(base), probeHash({ ...base, model: 'n' }));
  assert.notEqual(probeHash(base), probeHash({ ...base, strategy: 'json' }));
  assert.notEqual(probeHash(base), probeHash({ ...base, system: 'be terse' }));
});

test('the hash ignores what does not change the answer', () => {
  // Raising the sample count measures the same question better. Losing a
  // year of history for it would teach people never to raise it.
  const base = { provider: 'anthropic', model: 'm', messages: [{ role: 'user', content: 'a' }], temperature: 0, max_tokens: 512, strategy: 'exact' };

  assert.equal(probeHash({ ...base, samples: 12 }), probeHash({ ...base, samples: 60 }));
  assert.equal(probeHash({ ...base, notes: 'x' }), probeHash({ ...base, notes: 'y' }));
  assert.equal(probeHash({ ...base, tags: ['a'] }), probeHash({ ...base, tags: ['b'] }));
});

/* --------------------------------------------------------------- the cost */

test('the request count is what one run will actually cost', async () => {
  await withFile([
    { ...valid, samples: 10 },
    { ...valid, id: 'b', samples: 25 },
  ], async (file) => {
    const { probes } = await loadProbes(file);

    assert.equal(requestCount(probes), 35);
  });
});

test('probes group by provider so limits are not shared between them', async () => {
  await withFile([
    valid,
    { id: 'b', provider: 'openai', prompt: 'x' },
    { id: 'c', provider: 'anthropic', prompt: 'x' },
  ], async (file) => {
    const { probes } = await loadProbes(file);
    const groups = byProvider(probes);

    assert.equal(groups.anthropic.length, 2);
    assert.equal(groups.openai.length, 1);
  });
});
