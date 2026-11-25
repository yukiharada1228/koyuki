import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

test('collect never drops non-enumerable successes or failures', () => {
  const value = { id: 'valid' }, error = { kind: 'Invalid' as const };
  const source = Object.defineProperty({ hidden: ok(value), visible: ok(2) }, 'hidden', { enumerable: false });
  const result = collect(source);
  assert(result.ok); assert.equal(result.value.hidden, value); assert.deepEqual(result.value, { hidden: value, visible: 2 });
  assert(Object.isFrozen(result.value)); assert(!Object.isFrozen(value)); assert(!Object.isFrozen(source));
  const failed = Object.defineProperty({ hidden: err(error), visible: err('Other' as const) }, 'hidden', { enumerable: false });
  const failures = collect(failed);
  assert(!failures.ok); assert.equal(failures.error[0]?.error, error);
  assert.deepEqual(failures, err([{ field: 'hidden', error }, { field: 'visible', error: 'Other' }]));
});

test('numeric field names are runtime strings and remain correlated with their errors', () => {
  const result = collect({ 0: err('Zero' as const), name: err('Name' as const) });
  type Exact = Assert<Equal<typeof result, Result<{ readonly 0: never; readonly name: never }, readonly ({ readonly field: '0'; readonly error: 'Zero' } | { readonly field: 'name'; readonly error: 'Name' })[]>>>;
  assert.deepEqual(result, err([{ field: '0', error: 'Zero' }, { field: 'name', error: 'Name' }]));
  const dynamic: Record<number, Result<number, 'Invalid'>> = { Infinity: err('Invalid') };
  const broad = collect(dynamic);
  type Broad = Assert<Equal<typeof broad, Result<{ readonly [x: number]: number }, readonly { readonly field: string; readonly error: 'Invalid' }[]>>>;
  assert.deepEqual(broad, err([{ field: 'Infinity', error: 'Invalid' }]));
});

test('unsupported field descriptors reject before inspecting Results or invoking getters', () => {
  let reads = 0;
  const first = { get ok(): true { reads++; return true; }, value: 1 };
  const getters = Object.defineProperty({ first }, 'hidden', { get() { reads++; return err('Hidden'); } });
  const symbols = { first, [Symbol('hidden')]: err('Hidden') };
  for (const table of [getters, symbols]) assert.throws(() => collect(table), /CollectRequiresStringDataKeys/);
  assert.equal(reads, 0);
  assert.throws(() => collect(Object.create({ inherited: err('Hidden') })), /CollectRequiresPlainRecord/);
});

test('null-prototype records and prototype-like field names are collected safely', () => {
  const fields = { ['__proto__']: ok(1), constructor: ok(2) };
  Object.setPrototypeOf(fields, null);
  const result = collect(fields); assert(result.ok);
  assert.equal(result.value.__proto__, 1); assert.equal(result.value.constructor, 2);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.deepEqual(collect({}), ok({}));
});
