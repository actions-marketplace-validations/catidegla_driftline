import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureIdentity, compareIdentity, describeIdentity, hasIdentitySignal } from '../src/identity.mjs';

const headers = (obj) => new Map(Object.entries(obj));

test('the fingerprint providers ship for this purpose is captured', () => {
  const { reported } = captureIdentity({ system_fingerprint: 'fp_44709d6fcb', model: 'gpt-4.1-2025-04-14' });

  assert.equal(reported.system_fingerprint, 'fp_44709d6fcb');
  assert.equal(reported.model, 'gpt-4.1-2025-04-14');
});

test('a resolved model id counts even without a fingerprint', () => {
  // Anthropic and most others echo the snapshot they actually ran, which is
  // the whole signal once an alias moves underneath you.
  const { reported } = captureIdentity({ model: 'claude-sonnet-5' });

  assert.equal(reported.model, 'claude-sonnet-5');
  assert.equal(hasIdentitySignal({ reported }), true);
});

test('a provider that says nothing leaves us on statistics alone', () => {
  const capture = captureIdentity({ choices: [] }, headers({}));

  assert.deepEqual(capture.reported, {});
  assert.equal(hasIdentitySignal(capture), false);
});

test('non-string identity values are ignored rather than stringified', () => {
  const { reported } = captureIdentity({ model: 42, system_fingerprint: null });

  assert.deepEqual(reported, {});
});

test('a changed fingerprint is proof, not evidence', () => {
  const before = captureIdentity({ system_fingerprint: 'fp_aaa' });
  const after = captureIdentity({ system_fingerprint: 'fp_bbb' });

  const comparison = compareIdentity(before, after);

  assert.equal(comparison.proof, true);
  assert.equal(comparison.changed[0].key, 'system_fingerprint');
  assert.match(describeIdentity(comparison), /the provider saying the model changed/);
});

test('an unchanged identity is not proof of anything either way', () => {
  const capture = captureIdentity({ system_fingerprint: 'fp_aaa' });
  const comparison = compareIdentity(capture, capture);

  assert.equal(comparison.proof, false);
  assert.equal(describeIdentity(comparison), null);
});

test('a request id changing every call is not reported', () => {
  // It changes by design. Reporting it would make every run look like a
  // routing change and teach the reader to skip the section.
  const before = captureIdentity({}, headers({ 'x-request-id': 'req_1', 'openai-processing-ms': '120' }));
  const after = captureIdentity({}, headers({ 'x-request-id': 'req_2', 'openai-processing-ms': '450' }));

  assert.deepEqual(compareIdentity(before, after).moved, []);
});

test('a region change is a lead rather than proof', () => {
  const before = captureIdentity({ model: 'm' }, headers({ 'x-ms-region': 'westeurope' }));
  const after = captureIdentity({ model: 'm' }, headers({ 'x-ms-region': 'eastus' }));

  const comparison = compareIdentity(before, after);

  assert.equal(comparison.proof, false);
  assert.equal(comparison.moved[0].key, 'x-ms-region');
  assert.match(describeIdentity(comparison), /routing or deployment change/);
});

test('a key present on one side only is not a change', () => {
  // A provider that starts reporting something it used to omit has not told
  // us the model moved, only that it got chattier.
  const before = captureIdentity({ model: 'm' });
  const after = captureIdentity({ model: 'm', system_fingerprint: 'fp_new' });

  assert.equal(compareIdentity(before, after).proof, false);
});

test('a missing side is not comparable', () => {
  assert.equal(compareIdentity(null, captureIdentity({ model: 'm' })).comparable, false);
  assert.equal(compareIdentity(captureIdentity({ model: 'm' }), null).comparable, false);
});

test('headers work whether they arrive as a Headers object or a plain one', () => {
  const fromPlain = captureIdentity({}, { 'openai-version': '2020-10-01' });
  const fromMap = captureIdentity({}, headers({ 'openai-version': '2020-10-01' }));

  assert.deepEqual(fromPlain.headers, fromMap.headers);
});
