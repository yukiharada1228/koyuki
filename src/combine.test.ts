import test from 'node:test';
import assert from 'node:assert/strict';
import { business, workflow, combine, ok, err, type Result } from './framework/index.js';
declare const labelProof: unique symbol;
type Label = string & { readonly [labelProof]: true };
const label = (value: string): Result<Label, 'EmptyLabel'> => value.trim() ? ok(value.trim() as Label) : err('EmptyLabel');
const positive = (value: number): Result<number, 'InvalidCount'> => Number.isSafeInteger(value) && value > 0 ? ok(value) : err('InvalidCount');
test('combine preserves heterogeneous tuple positions, brands and empty tuples', () => {
  const result = combine([label(' Tag '), positive(2), ok(null)]);
  if (result.ok) {
    const tuple: readonly [Label, number, null] = result.value;
    assert(Object.isFrozen(tuple));
  }
  assert.deepEqual(result, ok(['Tag', 2, null]));
  assert.deepEqual(combine([]), ok([]));
});
test('combine returns the first failed Result unchanged without inspecting later entries', () => {
  const cause = { kind: 'Rejected' } as const, first = err(cause);
  const later: Result<never, 'Later'> = { get ok(): false { throw new Error('must not inspect'); }, error: 'Later' };
  const result = combine([ok(1), first, later]);
  assert.equal(result, first);
  assert(!result.ok); assert.equal(result.error, cause);
});
test('already-evaluated validations all run; combine does not promise lazy validation', () => {
  const calls: string[] = [];
  const reject = (name: string): Result<never, string> => { calls.push(name); return err(name); };
  assert.deepEqual(combine([reject('label'), reject('group'), reject('icon')]), err('label'));
  assert.deepEqual(calls, ['label', 'group', 'icon']);
});
test('only the output tuple container is owned; values remain caller-owned', () => {
  const value = { count: 1 }, input = [ok(value)];
  const result = combine(input); assert(result.ok);
  assert.equal(result.value[0], value); assert(!Object.isFrozen(value)); assert(!Object.isFrozen(input));
  value.count = 2; assert.equal(result.value[0]?.count, 2);
  input.push(ok({ count: 3 })); assert.equal(result.value.length, 1);
});
test('a workflow connects positional validations to creation and saves only a successful decision', async () => {
  const fields = workflow('fields', (input: { label: string; count: number }) => combine([label(input.label), positive(input.count)]))
    .then('create', ([name, count]) => ok({ name, count }));
  let saves = 0;
  const command = business({ name: 'tuple.v1', load: async (input: { label: string; count: number }) => ok(input),
    save: async (value: { name: Label; count: number }) => { saves++; return ok(value); }, operations: { create: [fields.run] } });
  assert.deepEqual(await command.create({ label: ' Tag ', count: 2 }), ok({ name: 'Tag', count: 2 }));
  assert.deepEqual(await command.create({ label: '', count: 0 }), err('EmptyLabel'));
  assert.deepEqual(await command.create({ label: 'Tag', count: 0 }), err('InvalidCount'));
  assert.equal(saves, 1);
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const tuple = combine([label('Tag'), positive(2)]);
const exact: Equal<typeof tuple, Result<readonly [Label, number], 'EmptyLabel' | 'InvalidCount'>> = true;
const empty: Equal<ReturnType<typeof combine<readonly []>>, Result<readonly [], never>> = true;
const array: Equal<ReturnType<typeof combine<readonly Result<number, 'Invalid'>[]>>, Result<readonly number[], 'Invalid'>> = true;
void exact; void empty; void array;
if (false) {
  // @ts-expect-error only Result values can be combined
  combine([ok(1), 2]);
  // @ts-expect-error asynchronous effects are not already-evaluated Result values
  combine([Promise.resolve(ok(1))]);
  if (tuple.ok) {
    // @ts-expect-error positions remain typed; the count is not a Label
    const wrong: Label = tuple.value[1];
    void wrong;
  }
}
