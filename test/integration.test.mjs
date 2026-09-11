import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'driftline.mjs');

/**
 * The whole pipeline, against a provider we control.
 *
 * A local server speaking the OpenAI chat shape, so this exercises the real
 * adapter, the real store, the real statistics and the real exit codes without
 * a key, a network or a bill. The server is also how we stage the one event
 * the tool exists for: a model that starts answering differently under a name
 * that did not change.
 */
function fakeApi() {
  const state = { answer: 'positive', fingerprint: 'fp_original', calls: 0 };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      state.calls += 1;

      res.writeHead(200, { 'content-type': 'application/json', 'openai-version': '2020-10-01' });
      res.end(JSON.stringify({
        model: 'local-model-1',
        system_fingerprint: state.fingerprint,
        choices: [{ message: { role: 'assistant', content: state.answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }));
    });
  });

  return { server, state };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function driftline(args, cwd, env) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('a stable provider reports stable, then a changed one is caught with proof', async (t) => {
  const { server, state } = fakeApi();
  const base = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'driftline-e2e-'));

  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const env = { OPENAI_COMPATIBLE_BASE_URL: base, OPENAI_COMPATIBLE_API_KEY: 'not-required' };

  await writeFile(join(dir, 'probes.jsonl'), JSON.stringify({
    id: 'sentiment',
    provider: 'compatible',
    model: 'local-model-1',
    prompt: 'The delivery arrived, eventually.',
    strategy: 'lenient',
    samples: 10,
  }) + '\n');

  /* 1. A first reading. Nothing to compare against yet, and it says so. */
  const first = await driftline(['baseline', '--db', 'h.db'], dir, env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /10\/10 gave the same answer/);
  assert.equal(state.calls, 10);

  /* 2. Same provider, same answers. The canary must stay quiet. */
  const quiet = await driftline(['check', '--db', 'h.db', '--json'], dir, env);
  const quietResult = JSON.parse(quiet.stdout);

  assert.equal(quiet.code, 0, 'a provider that did not change must exit clean');
  assert.equal(quietResult.summary.clean, true);

  /* 3. Another quiet run, so the control band has a window to sit in. */
  await driftline(['check', '--db', 'h.db', '--json'], dir, env);

  /* 4. The vendor rolls an update. Same model name, different answers and a
        different fingerprint, which is exactly the day this tool is for. */
  state.answer = 'neutral';
  state.fingerprint = 'fp_rolled';

  const caught = await driftline(['check', '--db', 'h.db', '--json'], dir, env);
  const result = JSON.parse(caught.stdout);

  assert.equal(caught.code, 1, 'drift must exit 1');
  assert.equal(result.summary.drifted, 1);
  assert.equal(result.summary.proven, 1, 'the provider reported it, so this is proof rather than inference');

  const probe = result.probes[0];
  assert.equal(probe.status, 'drifted');
  assert.equal(probe.confidence, 'proof');
  assert.match(probe.reason, /different system_fingerprint/);
  assert.equal(probe.effect, 1, 'every answer changed');
});

test('a change the provider does not admit to is still caught statistically', async (t) => {
  const { server, state } = fakeApi();
  const base = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'driftline-e2e2-'));

  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const env = { OPENAI_COMPATIBLE_BASE_URL: base, OPENAI_COMPATIBLE_API_KEY: 'not-required' };

  await writeFile(join(dir, 'probes.jsonl'), JSON.stringify({
    id: 'sentiment', provider: 'compatible', model: 'local-model-1',
    prompt: 'x', strategy: 'lenient', samples: 12,
  }) + '\n');

  await driftline(['baseline', '--db', 'h.db'], dir, env);

  // The answer moves. The fingerprint does not, which is the common case and
  // the reason the statistics exist at all.
  state.answer = 'negative';

  const caught = await driftline(['check', '--db', 'h.db', '--json'], dir, env);
  const probe = JSON.parse(caught.stdout).probes[0];

  assert.equal(caught.code, 1);
  assert.equal(probe.status, 'drifted');
  assert.equal(probe.confidence, 'evidence', 'no identity change, so this rests on the distribution');
  assert.ok(probe.adjusted < 0.05, `adjusted p was ${probe.adjusted}`);
});

test('a provider that is down exits unreadable rather than reporting drift', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'driftline-e2e3-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  // A port nothing is listening on. The distinction between "the model
  // changed" and "we could not find out" is the difference between a real
  // page and waking somebody for an expired key.
  const env = { OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1', OPENAI_COMPATIBLE_API_KEY: 'x' };

  await writeFile(join(dir, 'probes.jsonl'), JSON.stringify({
    id: 'unreachable', provider: 'compatible', model: 'm', prompt: 'x', samples: 2,
  }) + '\n');

  const result = await driftline(['check', '--db', 'h.db', '--json'], dir, env);

  assert.equal(result.code, 3, 'unreadable is its own exit code, not the drift one');
});

test('the markdown report is what a pull request comment needs', async (t) => {
  const { server, state } = fakeApi();
  const base = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'driftline-e2e4-'));

  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const env = { OPENAI_COMPATIBLE_BASE_URL: base, OPENAI_COMPATIBLE_API_KEY: 'not-required' };

  await writeFile(join(dir, 'probes.jsonl'), JSON.stringify({
    id: 'contract', provider: 'compatible', model: 'm', prompt: 'x', strategy: 'lenient', samples: 8,
  }) + '\n');

  await driftline(['baseline', '--db', 'h.db'], dir, env);
  state.answer = 'something else entirely';
  state.fingerprint = 'fp_two';

  const result = await driftline(['check', '--db', 'h.db', '--markdown'], dir, env);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /### driftline/);
  assert.match(result.stdout, /\| Probe \|/);
  assert.match(result.stdout, /the provider reported a different model/);
});
