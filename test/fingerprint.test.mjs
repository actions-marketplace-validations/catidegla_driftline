import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fingerprint, tally, mode, looksLikeRefusal, STRATEGIES } from '../src/fingerprint.mjs';

test('exact ignores whitespace but nothing else', () => {
  assert.equal(fingerprint('  hello   world \n'), fingerprint('hello world'));
  assert.notEqual(fingerprint('hello world'), fingerprint('hello worlds'));
  assert.notEqual(fingerprint('Hello world'), fingerprint('hello world'));
});

test('lenient folds case and punctuation away', () => {
  assert.equal(fingerprint('Positive.', 'lenient'), fingerprint('positive', 'lenient'));
  assert.equal(fingerprint('POSITIVE!', 'lenient'), fingerprint('positive', 'lenient'));
  assert.notEqual(fingerprint('positive', 'lenient'), fingerprint('negative', 'lenient'));
});

test('json ignores key order but not values', () => {
  assert.equal(fingerprint('{"a":1,"b":2}', 'json'), fingerprint('{"b":2,"a":1}', 'json'));
  assert.notEqual(fingerprint('{"a":1}', 'json'), fingerprint('{"a":2}', 'json'));
});

test('json digs the object out of the prose models wrap it in', () => {
  // Models add "Here is the JSON:" and fences constantly, and a strategy that
  // only handles clean output would report drift the first time one did.
  const bare = fingerprint('{"ok":true}', 'json');

  assert.equal(fingerprint('Here you go:\n```json\n{"ok":true}\n```', 'json'), bare);
  assert.equal(fingerprint('Sure! {"ok":true} Hope that helps.', 'json'), bare);
});

test('unparseable json is its own category rather than an error', () => {
  // It has to be countable, because "the model stopped returning JSON" is the
  // exact event this strategy exists to catch.
  assert.equal(fingerprint('not json at all', 'json'), 'unparseable');
  assert.equal(fingerprint('', 'json'), 'unparseable');
});

test('shape sees the structure and ignores the values', () => {
  assert.equal(fingerprint('{"a":1,"b":"x"}', 'shape'), fingerprint('{"a":99,"b":"zzz"}', 'shape'));
  assert.notEqual(fingerprint('{"a":1}', 'shape'), fingerprint('{"a":1,"c":2}', 'shape'));
  assert.notEqual(fingerprint('{"a":1}', 'shape'), fingerprint('{"a":"1"}', 'shape'));
});

test('shape collapses an array of the same thing whatever its length', () => {
  assert.equal(fingerprint('[1,2,3]', 'shape'), fingerprint('[7]', 'shape'));
  assert.notEqual(fingerprint('[1,2,3]', 'shape'), fingerprint('["a"]', 'shape'));
});

test('first line ignores the explanation underneath', () => {
  assert.equal(
    fingerprint('positive\nBecause the tone is warm.', 'first_line'),
    fingerprint('positive\nBecause the delivery arrived.', 'first_line'),
  );
});

test('refusal is two categories and nothing more', () => {
  assert.equal(fingerprint('I cannot help with that.', 'refusal'), 'refused');
  assert.equal(fingerprint('Sure, here is how.', 'refusal'), 'answered');
  assert.equal(
    fingerprint('I cannot help with that.', 'refusal'),
    fingerprint('I cannot assist with this request.', 'refusal'),
  );
});

test('refusal detection looks near the start, not anywhere', () => {
  assert.equal(looksLikeRefusal("I'm sorry, I can't do that."), true);
  assert.equal(looksLikeRefusal('I cannot stress enough how useful this is'), true);

  // Four paragraphs in, "cannot" is content rather than a refusal.
  const long = 'Here is the answer. '.repeat(20) + 'You cannot do this in production.';
  assert.equal(looksLikeRefusal(long), false);
});

test('an empty answer is not a refusal', () => {
  assert.equal(looksLikeRefusal(''), false);
  assert.equal(looksLikeRefusal('   '), false);
});

test('an unknown strategy throws rather than falling back', () => {
  // A typo in a probe file would otherwise change what is being watched
  // without telling anybody.
  assert.throws(() => fingerprint('x', 'exakt'), /unknown fingerprint strategy/);
});

test('every advertised strategy is callable', () => {
  for (const name of Object.keys(STRATEGIES)) {
    assert.equal(typeof fingerprint('{"a":1}', name), 'string', name);
  }
});

test('tally counts a sample into categories', () => {
  const counts = tally(['yes', 'yes', 'no'], 'lenient');

  assert.equal(Object.keys(counts).length, 2);
  assert.deepEqual(Object.values(counts).sort(), [1, 2]);
});

test('mode reports the dominant answer and how dominant', () => {
  const m = mode(tally(['a', 'a', 'a', 'b'], 'lenient'));

  assert.equal(m.count, 3);
  assert.equal(m.share, 0.75);
});

test('mode of nothing is nothing rather than a crash', () => {
  assert.deepEqual(mode({}), { fingerprint: null, count: 0, share: 0 });
});
