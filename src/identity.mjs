/**
 * What the provider told us about which model actually answered.
 *
 * This runs before any statistics and it is the more important half of the
 * tool, because when it fires there is nothing to infer. A provider that
 * changes the fingerprint it reports has told you the model changed. No
 * sampling, no p-value, no argument.
 *
 * The statistics exist for the other case, which is the common one: the
 * provider says nothing, or says the same thing it said yesterday, and the
 * outputs move anyway. Then all you have is the distribution.
 *
 * The order matters and it is the same order a payment reconciler uses on a
 * disputed transaction: take the counterparty's own statement first, fall back
 * to inference only where they are silent, and never let inference overrule a
 * direct answer.
 */

/** Ranked by how much it pins the model down, most specific first. */
const IDENTITY_KEYS = [
  // OpenAI ships this for exactly this purpose: a hash of the backend
  // configuration, documented as changing when the backend changes.
  'system_fingerprint',
  // Anthropic and most others echo the model they actually resolved, which
  // differs from the alias you asked for once a snapshot moves.
  'model',
  // Google returns the version separately from the model name.
  'modelVersion',
];

/**
 * Response headers worth keeping.
 *
 * Not for identity on their own, but a deployment or region header changing at
 * the same moment the outputs move is the difference between "the model
 * changed" and "you got routed somewhere else", and those have different
 * fixes.
 */
const HEADER_KEYS = [
  'anthropic-organization-id',
  'openai-version',
  'openai-processing-ms',
  'x-request-id',
  'x-ms-region',
  'azureml-model-session',
  'server',
];

/**
 * Pull whatever the provider is willing to say from one response.
 *
 * @param {object} body    the decoded response body
 * @param {Headers|Map|object} headers
 * @returns {{reported: Record<string,string>, headers: Record<string,string>}}
 */
export function captureIdentity(body = {}, headers = null) {
  const reported = {};

  for (const key of IDENTITY_KEYS) {
    const value = body?.[key];
    if (typeof value === 'string' && value !== '') reported[key] = value;
  }

  const kept = {};

  if (headers) {
    const get = typeof headers.get === 'function'
      ? (k) => headers.get(k)
      : (k) => headers[k] ?? headers[k.toLowerCase()];

    for (const key of HEADER_KEYS) {
      const value = get(key);
      // Deliberately excluded from identity comparison further down, because
      // a per-request id or a latency changes every call by design.
      if (typeof value === 'string' && value !== '') kept[key] = value;
    }
  }

  return { reported, headers: kept };
}

/** Headers that change every request and would make every run look like drift. */
const VOLATILE_HEADERS = new Set(['x-request-id', 'openai-processing-ms']);

/**
 * Compare two identity captures.
 *
 * `changed` is reserved for the keys that are supposed to be stable. A changed
 * system_fingerprint is proof. A changed region is a lead. A changed request
 * id is nothing, and is filtered rather than reported, because a signal that
 * fires on every run teaches people to ignore the one that matters.
 */
export function compareIdentity(before, after) {
  if (!before || !after) return { comparable: false, changed: [], moved: [], proof: false };

  const changed = [];
  const moved = [];

  for (const key of IDENTITY_KEYS) {
    const a = before.reported?.[key];
    const b = after.reported?.[key];
    if (a !== undefined && b !== undefined && a !== b) changed.push({ key, before: a, after: b });
  }

  for (const key of Object.keys({ ...before.headers, ...after.headers })) {
    if (VOLATILE_HEADERS.has(key)) continue;
    const a = before.headers?.[key];
    const b = after.headers?.[key];
    if (a !== undefined && b !== undefined && a !== b) moved.push({ key, before: a, after: b });
  }

  return {
    comparable: true,
    changed,
    moved,
    // The whole reason this module runs first.
    proof: changed.length > 0,
  };
}

/**
 * One line for a human, or null when the provider said nothing useful.
 *
 * Null rather than "no change detected", because a provider that reports no
 * identity at all and a provider reporting an unchanged one are different
 * situations, and only the second is reassuring.
 */
export function describeIdentity(comparison) {
  if (!comparison?.comparable) return null;

  if (comparison.changed.length) {
    const [first] = comparison.changed;
    return `the provider is reporting a different ${first.key}: ${first.before} became ${first.after}. ` +
      'That is the provider saying the model changed, so nothing below is in doubt.';
  }

  if (comparison.moved.length) {
    const [first] = comparison.moved;
    return `the model identity is unchanged, but ${first.key} moved from ${first.before} to ${first.after}, ` +
      'so a routing or deployment change is worth ruling out before the model is blamed.';
  }

  return null;
}

/**
 * Whether this provider gives us anything to compare at all.
 *
 * Worth saying out loud in the report. A run against a provider that reports
 * no identity is running on statistics alone, and the reader should know that
 * rather than assume silence means stability.
 */
export function hasIdentitySignal(capture) {
  return Boolean(capture && Object.keys(capture.reported ?? {}).length > 0);
}
