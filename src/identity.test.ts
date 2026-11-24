import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIdentity } from './framework/identity.js';
test('decision identity compares normalized content without hashing', () => {
  assert.equal(canonicalIdentity({ b: [1, 2], a: true }), canonicalIdentity({ a: true, b: [1, 2] }));
  assert.notEqual(canonicalIdentity({ a: 1 }), canonicalIdentity({ a: '1' }));
  assert.notEqual(canonicalIdentity([1, 2]), canonicalIdentity([2, 1]));
});
test('identity rejects values JSON would silently discard or change', () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const input of [undefined, NaN, Infinity, { a: undefined }, new Date(), cyclic, { [Symbol('hidden')]: 1 }]) assert.throws(() => canonicalIdentity(input));
});
