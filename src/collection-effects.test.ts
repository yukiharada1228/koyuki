import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEffects, process, ok, err, type Result } from './framework/index.js';
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
test('effect collection is lazy, bounded, and returns failures in original input order', async () => {
  const first = gate(), second = gate();
  let active = 0, peak = 0;
  const started: number[] = [], failure = { kind: 'Offline' as const };
  const send = collectEffects(async (item: number): Promise<Result<string, typeof failure>> => {
    started.push(item); peak = Math.max(peak, ++active);
    if (item === 0) await first.promise;
    if (item === 1) await second.promise;
    active--;
    return item < 2 ? err(failure) : ok(String(item));
  }, { concurrency: 2 });
  assert.deepEqual(started, []);
  const pending = send([0, 1, 2]); assert.deepEqual(started, [0, 1]);
  second.release(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]); first.release();
  const result = await pending;
  assert.deepEqual(result, err([{ index: 0, error: failure }, { index: 1, error: failure }]));
  assert(!result.ok); assert(Object.isFrozen(result.error)); assert.equal(result.error[0]?.error, failure);
  assert.equal(peak, 2);
});
test('success keeps input order and identity; each call owns its positions', async () => {
  const first = gate(), input = [{ id: 1 }, { id: 2 }];
  const collect = collectEffects(async (item: { id: number }) => { if (item.id === 1) await first.promise; return ok(item); }, { concurrency: 2 });
  const pending = collect(input); const original = input[0]; input.splice(0); first.release();
  const result = await pending; assert(result.ok); assert.equal(result.value[0], original); assert.deepEqual(result.value.map(x => x.id), [1, 2]);
  assert(Object.isFrozen(result.value)); assert(!Object.isFrozen(original));
  assert.deepEqual(await collect([]), ok([]));
});
test('defects stop new scheduling and await in-flight effects before rejecting', async () => {
  const fail = gate(), finish = gate(), defect = new Error('defect');
  const started: number[] = [], finished: number[] = [];
  const run = collectEffects(async (item: number) => {
    started.push(item);
    if (item === 0) { await fail.promise; throw defect; }
    await finish.promise; finished.push(item); return ok(item);
  }, { concurrency: 2 });
  let settled = false;
  const result = run([0, 1, 2]).catch(error => { settled = true; return error; });
  fail.release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.deepEqual(started, [0, 1]);
  finish.release(); assert.equal(await result, defect); assert.deepEqual(finished, [1]);
  const thrown = collectEffects((_item: number): Promise<Result<number, never>> => { throw undefined; }, { concurrency: 1 });
  let rejected = false; await thrown([1]).catch(cause => { rejected = true; assert.equal(cause, undefined); }); assert(rejected);
});
test('collected domain failures stop the enclosing process after every send was attempted', async () => {
  const sent: string[] = []; let after = 0;
  const batch = collectEffects(async (store: string): Promise<Result<string, 'Offline'>> => {
    sent.push(store); return store === 'b' ? err('Offline') : ok(store);
  }, { concurrency: 1 });
  const flow = process<readonly string[]>().effect('send-stores', batch)
    .effect('after', async results => { after++; return ok(results.length); });
  assert.deepEqual(await flow.run(['a', 'b', 'c']), err([{ index: 1, error: 'Offline' }]));
  assert.deepEqual(sent, ['a', 'b', 'c']); assert.equal(after, 0);
});
test('invalid concurrency is rejected before executing effects', () => {
  for (const concurrency of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => collectEffects(async (n: number) => ok(n), { concurrency }), RangeError);
});
if (false) {
  // @ts-expect-error synchronous rules use collectEach, not the IO collection
  collectEffects((n: number) => ok(n), { concurrency: 1 });
  // @ts-expect-error execution policy must be explicit
  collectEffects(async (n: number) => ok(n));
  // @ts-expect-error preserve each effect's input type
  collectEffects(async (n: number) => ok(n), { concurrency: 1 })(['bad']);
}
test('concurrent invocations have independent cursors and snapshot concurrency configuration', async () => {
  const options = { concurrency: 1 }, hold = gate(), seen: number[] = [];
  const collect = collectEffects(async (n: number) => { seen.push(n); if (n === 1) await hold.promise; return ok(n * 2); }, options);
  options.concurrency = 99;
  const slow = collect([1, 2]);
  assert.deepEqual(await collect([3, 4]), ok([6, 8]));
  assert.deepEqual(seen, [1, 3, 4]); hold.release(); assert.deepEqual(await slow, ok([2, 4]));
});
const typedBatch = collectEffects(async (n: number): Promise<Result<string, 'Offline'>> => ok(String(n)), { concurrency: 2 });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ExactInput = Assert<Equal<Parameters<typeof typedBatch>[0], readonly number[]>>;
type ExactOutput = Assert<Equal<Awaited<ReturnType<typeof typedBatch>>, Result<readonly string[], readonly { readonly index: number; readonly error: 'Offline' }[]>>>;
