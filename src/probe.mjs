/**
 * Loading and checking the probes.
 *
 * A probe is a question you will ask the same way forever. That is the whole
 * design constraint: the moment a probe changes, its history stops meaning
 * anything, because a different question producing a different answer is not
 * drift. So every probe carries a content hash of the parts that determine the
 * answer, and a run against a changed probe is refused rather than compared.
 *
 * Validation is strict and names the line, for the same reason it is strict in
 * any dataset loader: a silently skipped probe makes a canary look healthy
 * when it never ran.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { STRATEGIES, DEFAULT_STRATEGY } from './fingerprint.mjs';
import { PROVIDERS } from './providers/index.mjs';

const KNOWN_KEYS = new Set([
  'id', 'provider', 'model', 'prompt', 'messages', 'system',
  'temperature', 'max_tokens', 'seed', 'samples', 'strategy', 'tags', 'notes',
]);

export const DEFAULT_SAMPLES = 12;

/**
 * The fields that determine the answer, hashed.
 *
 * Deliberately excludes samples, tags and notes. Raising the sample count
 * makes the same question better measured, not different, and losing a year
 * of history because somebody added a note would teach people not to write
 * notes.
 */
export function probeHash(probe) {
  const material = {
    provider: probe.provider,
    model: probe.model ?? null,
    system: probe.system ?? null,
    messages: probe.messages,
    temperature: probe.temperature,
    max_tokens: probe.max_tokens,
    seed: probe.seed ?? null,
    strategy: probe.strategy,
  };

  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

function validate(record, where, seen) {
  const problems = [];
  const push = (m) => problems.push(`${where} ${m}`);

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      push(`has an unknown key "${key}". Known keys: ${[...KNOWN_KEYS].join(', ')}`);
    }
  }

  if (typeof record.id !== 'string' || record.id.trim() === '') {
    push('needs a non-empty string id');
  } else if (seen.has(record.id)) {
    // History joins on id. A duplicate silently merges two probes into one
    // distribution, which would read as violent drift on every run.
    push(`repeats the id "${record.id}", which is already used`);
  } else {
    seen.add(record.id);
  }

  if (!record.provider || !PROVIDERS[record.provider]) {
    push(`needs a provider, one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const hasPrompt = typeof record.prompt === 'string' && record.prompt.trim() !== '';
  const hasMessages = Array.isArray(record.messages) && record.messages.length > 0;

  if (!hasPrompt && !hasMessages) {
    push('needs either a prompt or a non-empty messages array');
  }

  if (hasPrompt && hasMessages) {
    push('has both prompt and messages, and only one can be the question');
  }

  if (hasMessages) {
    record.messages.forEach((m, i) => {
      if (!m || typeof m.content !== 'string' || !['user', 'assistant'].includes(m.role)) {
        push(`message ${i} needs a role of user or assistant and a string content`);
      }
    });
  }

  if (record.strategy !== undefined && !STRATEGIES[record.strategy]) {
    push(`has strategy "${record.strategy}", which is not one of: ${Object.keys(STRATEGIES).join(', ')}`);
  }

  if (record.samples !== undefined) {
    const n = Number(record.samples);
    if (!Number.isInteger(n) || n < 2) {
      // One sample cannot have a distribution, so a probe set to one would
      // report a category change on every different answer forever.
      push('needs samples to be a whole number of at least 2, since one sample has no distribution');
    }
    if (n > 200) push('has samples above 200, which is a lot of money per run');
  }

  if (record.temperature !== undefined) {
    const t = Number(record.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) push('needs temperature between 0 and 2');
  }

  return problems;
}

function normalise(record) {
  const messages = record.messages ?? [{ role: 'user', content: record.prompt }];

  return {
    id: record.id,
    provider: record.provider,
    model: record.model ?? PROVIDERS[record.provider]?.defaultModel ?? null,
    system: record.system ?? null,
    messages,
    temperature: record.temperature ?? 0,
    max_tokens: record.max_tokens ?? 512,
    seed: record.seed,
    samples: record.samples ?? DEFAULT_SAMPLES,
    strategy: record.strategy ?? DEFAULT_STRATEGY,
    tags: record.tags ?? [],
    notes: record.notes ?? null,
  };
}

/**
 * Read a probe file.
 *
 * JSON lines rather than one array, so a diff of one changed probe is one
 * changed line and a malformed probe is one bad line rather than an
 * unreadable file.
 *
 * @returns {Promise<{probes: Array, problems: string[]}>}
 */
export async function loadProbes(file) {
  let raw;

  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { probes: [], problems: [`${file} could not be read: ${error.message}`] };
  }

  const problems = [];
  const probes = [];
  const seen = new Set();

  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) return;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      problems.push(`${file}:${index + 1} is not valid JSON: ${error.message}`);
      return;
    }

    const found = validate(record, `${file}:${index + 1}`, seen);

    if (found.length) {
      problems.push(...found);
      return;
    }

    const probe = normalise(record);
    probes.push({ ...probe, hash: probeHash(probe) });
  });

  return { probes, problems };
}

/**
 * How much one run of this probe set will cost in requests.
 *
 * Printed before anything is sent. A canary is a recurring bill and the first
 * thing somebody wants to know is how big, before it arrives rather than after.
 */
export function requestCount(probes) {
  return probes.reduce((sum, p) => sum + p.samples, 0);
}

/** Group by provider, for reporting and for per-provider concurrency limits. */
export function byProvider(probes) {
  const groups = {};
  for (const probe of probes) (groups[probe.provider] ??= []).push(probe);
  return groups;
}
