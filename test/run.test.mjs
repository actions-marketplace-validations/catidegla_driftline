import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleProbe, sampleAll, MAX_FAILURE_SHARE } from '../src/run.mjs';
import { ProviderError } from '../src/providers/index.mjs';
import { captureIdentity } from '../src/identity.mjs';

/**
 * A provider that never touches a network.
 *
 * Every test in here runs against this. A test suite for a tool that calls
 * paid APIs must never call one: it would cost money on every commit, fail
 * whenever a vendor has a bad afternoon, and change its answers under you,
 * which is precisely the behaviour this tool exists to detect.
 */
function fakeProvider(script) {
  let call = 0;

  return {
    async complete() {
      const step = script[call++ % script.length];

      if (step instanceof Error) throw step;

      return {
        text: step.text ?? step,
        usage: { input: 10, output: 5 },
        stopReason: 'end_turn',
        identity: captureIdentity({ model: step.model ?? 'm' }),
      };
    },
  };
}

const probe = (extra = {}) => ({
  id: 'p', hash: 'h', provider: 'anthropic', model: 'm',
  messages: [{ role: 'user', content: 'x' }], system: null,
  temperature: 0, max_tokens: 64, samples: 10, strategy: 'exact', ...extra,
});

test('a sample becomes counted categories', async () => {
  const o = await sampleProbe(probe(), { transport: fakeProvider(['yes', 'yes', 'no']) });

  assert.equal(o.samples, 10);
  assert.equal(Object.values(o.counts).reduce((s, n) => s + n, 0), 10);
  assert.equal(Object.keys(o.counts).length, 2);
  assert.equal(o.errors, 0);
});

test('usage is totalled across the sample, since that is the bill', async () => {
  const o = await sampleProbe(probe({ samples: 4 }), { transport: fakeProvider(['a']) });

  assert.equal(o.usage.input, 40);
  assert.equal(o.usage.output, 20);
});

test('a failed request is counted and never folded into the distribution', async () => {
  // This is the rule the whole tool rests on. A rate limit that quietly
  // shortened the sample would shift the distribution, and the canary would
  // blame the model for its own network.
  const boom = new ProviderError('429 slow down', { provider: 'anthropic', retryable: true });
  const o = await sampleProbe(probe({ samples: 10 }), { transport: fakeProvider(['a', boom]) });

  assert.equal(o.errors, 5);
  assert.equal(Object.values(o.counts).reduce((s, n) => s + n, 0), 5);
  assert.ok(o.errorMessages[0].includes('429'));
});

test('losing too much of the sample marks the probe unreadable', async () => {
  const boom = new ProviderError('down', { provider: 'anthropic' });
  const mostly = await sampleProbe(probe({ samples: 10 }), { transport: fakeProvider([boom, boom, boom, 'a']) });

  assert.ok(mostly.errors > 10 * MAX_FAILURE_SHARE);
  assert.equal(mostly.unreadable, true);
});

test('a little loss is tolerated rather than throwing the run away', async () => {
  const boom = new ProviderError('blip', { provider: 'anthropic' });
  const o = await sampleProbe(probe({ samples: 20 }), { transport: fakeProvider(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', boom]) });

  assert.equal(o.errors, 2);
  assert.equal(o.unreadable, false);
});

test('a rollout caught mid-flight shows two identities inside one sample', async () => {
  // Half the requests answered by a new backend. Invisible to anything that
  // only compares today against yesterday, because today is internally split.
  const o = await sampleProbe(probe({ samples: 10 }), {
    transport: fakeProvider([{ text: 'a', model: 'old' }, { text: 'a', model: 'new' }]),
  });

  assert.equal(o.identitySpread.length, 2);
  assert.deepEqual(o.identitySpread.map((s) => s.count).sort(), [5, 5]);
});

test('concurrency does not change what comes back', async () => {
  const script = ['a', 'b', 'a', 'a'];
  const serial = await sampleProbe(probe({ samples: 12 }), { transport: fakeProvider(script), concurrency: 1 });
  const parallel = await sampleProbe(probe({ samples: 12 }), { transport: fakeProvider(script), concurrency: 8 });

  assert.deepEqual(
    Object.values(serial.counts).sort((a, b) => a - b),
    Object.values(parallel.counts).sort((a, b) => a - b),
  );
});

test('the probe hash travels with the observation', async () => {
  // Without it the verdict cannot tell a changed answer from a changed
  // question, which is the difference between drift and noise.
  const o = await sampleProbe(probe({ hash: 'abc123' }), { transport: fakeProvider(['a']) });

  assert.equal(o.probeHash, 'abc123');
});

test('sampling many probes reports each one as it lands', async () => {
  const seen = [];

  const all = await sampleAll(
    [probe({ id: 'one', samples: 2 }), probe({ id: 'two', samples: 2 })],
    { transport: fakeProvider(['a']), onProbe: (o) => seen.push(o.probeId) },
  );

  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(all.length, 2);
});

test('the strategy on the probe is the one applied to the sample', async () => {
  const lenient = await sampleProbe(probe({ strategy: 'lenient' }), { transport: fakeProvider(['Yes.', 'yes', 'YES!']) });
  const exact = await sampleProbe(probe({ strategy: 'exact' }), { transport: fakeProvider(['Yes.', 'yes', 'YES!']) });

  assert.equal(Object.keys(lenient.counts).length, 1);
  assert.equal(Object.keys(exact.counts).length, 3);
});
