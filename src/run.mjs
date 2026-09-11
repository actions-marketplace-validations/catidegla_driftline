/**
 * Taking the sample.
 *
 * The only interesting decisions here are about money and about what to do
 * when a request fails, and the second one is the one that decides whether the
 * tool can be trusted.
 *
 * A failed request is never quietly dropped from the sample. Dropping it would
 * shorten today's run, shift the distribution, and the canary would report
 * drift caused entirely by a rate limit. Failures are counted, carried into
 * the verdict, and a probe that loses too much of its sample is reported as
 * unreadable rather than as changed.
 */

import { resolveProvider, ProviderError } from './providers/index.mjs';
import { tally } from './fingerprint.mjs';

export const DEFAULT_CONCURRENCY = 4;

/**
 * The share of a sample that may fail before the probe is unreadable.
 *
 * A fifth is generous on purpose. The alternative to tolerating some loss is
 * throwing away a whole morning's run because one request in twenty timed out,
 * and a canary that needs a perfect network is a canary that never reports.
 */
export const MAX_FAILURE_SHARE = 0.2;

/** Run tasks with a bounded number in flight, preserving input order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);

  return results;
}

/**
 * Sample one probe.
 *
 * Every sample is an independent request on purpose. Asking a provider for n
 * completions in one call is cheaper and measures something else: many
 * providers sample those jointly, so the variation you see is not the
 * variation a user sees across n separate visits, which is the thing being
 * watched.
 */
export async function sampleProbe(probe, { concurrency = DEFAULT_CONCURRENCY, onSample = null, transport = null } = {}) {
  const provider = transport ?? resolveProvider(probe.provider);
  const started = Date.now();

  const attempts = await pool(
    Array.from({ length: probe.samples }, (_, i) => i),
    concurrency,
    async () => {
      try {
        const answer = await provider.complete({
          model: probe.model,
          messages: probe.messages,
          system: probe.system,
          temperature: probe.temperature,
          maxTokens: probe.max_tokens,
          seed: probe.seed,
        });

        onSample?.({ ok: true });

        return { ok: true, ...answer };
      } catch (error) {
        onSample?.({ ok: false });

        return {
          ok: false,
          error: error instanceof ProviderError ? error.message : String(error?.message ?? error),
          status: error?.status ?? null,
        };
      }
    },
  );

  const good = attempts.filter((a) => a.ok);
  const bad = attempts.filter((a) => !a.ok);

  const usage = good.reduce(
    (acc, a) => ({
      input: acc.input + (a.usage?.input ?? 0),
      output: acc.output + (a.usage?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );

  return {
    probeId: probe.id,
    probeHash: probe.hash,
    provider: probe.provider,
    model: probe.model,
    strategy: probe.strategy,
    samples: probe.samples,
    counts: tally(good.map((a) => a.text), probe.strategy),
    // The last good answer's identity. They should all agree within a run, and
    // when they do not that is itself worth seeing, so disagreement is kept.
    identity: good.at(-1)?.identity ?? null,
    identitySpread: countIdentities(good),
    usage,
    latencyMs: Date.now() - started,
    errors: bad.length,
    errorMessages: [...new Set(bad.map((b) => b.error))].slice(0, 3),
    unreadable: bad.length > probe.samples * MAX_FAILURE_SHARE,
  };
}

/**
 * How many distinct model identities answered inside one probe's sample.
 *
 * More than one means the provider is mid-rollout and routing some share of
 * traffic to a new backend. That is drift caught in the act, and it is
 * invisible to anything that only compares today against yesterday.
 */
function countIdentities(answers) {
  const seen = new Map();

  for (const a of answers) {
    const key = JSON.stringify(a.identity?.reported ?? {});
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  return [...seen.entries()].map(([identity, count]) => ({ identity: JSON.parse(identity), count }));
}

/** Sample every probe, one provider at a time so limits are not shared. */
export async function sampleAll(probes, options = {}) {
  const observations = [];

  for (const probe of probes) {
    observations.push(await sampleProbe(probe, options));
    options.onProbe?.(observations.at(-1));
  }

  return observations;
}
