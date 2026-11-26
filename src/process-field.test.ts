import test from 'node:test';
import assert from 'node:assert/strict';
import { process, ok, err, describeFlow, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

test('named effects preserve request facts and opaque results without projection callbacks', async () => {
  class Row { #secret = 3; read() { return this.#secret; } }
  const row = new Row(), proof = Symbol('proof'), input = { id: 'a', [proof]: true as const };
  let calls = 0;
  const flow = process<typeof input>()
    .effect('read', async context => { calls++; assert.strictEqual(context, input); return ok(row); }, 'current')
    .effect('use', async context => ok(context.current.read() + context.id.length));
  type Output = Assert<Equal<Awaited<ReturnType<typeof flow.run>>, Result<number, never>>>;
  assert.equal(calls, 0);
  const report = await flow.runDetailed(input, { input: () => null, result: result => result.ok ? typeof result.value : null });
  assert.deepEqual(report.result, ok(4)); assert.equal(calls, 1);
  assert.deepEqual(report.trace.map(entry => entry.step), ['read', 'use']);
  assert.deepEqual(describeFlow(flow).nodes.map(node => node.name), ['read', 'use']);
  const attached = await process<typeof input>().effect('read', async () => ok(row), 'current').run(input);
  assert(attached.ok); assert.strictEqual(attached.value.current, row); assert.equal(attached.value[proof], true);
  assert.notStrictEqual(attached.value, input); assert.deepEqual(Reflect.ownKeys(input), ['id', proof]);
});

test('named effects keep failures and do not execute later IO', async () => {
  const failure = err('Unavailable' as const); let later = 0;
  const flow = process<{ id: string }>()
    .effect('read', async (): Promise<Result<number, 'Unavailable'>> => failure, 'current')
    .effect('later', async context => { later++; return ok(context.current); }, 'next');
  type Output = Assert<Equal<Awaited<ReturnType<typeof flow.run>>, Result<{ id: string } & Readonly<{ current: number }> & Readonly<{ next: number }>, 'Unavailable'>>>;
  const report = await flow.runDetailed({ id: 'a' });
  assert.strictEqual(report.result, failure); assert.equal(later, 0);
  assert.deepEqual(report.trace, [{ step: 'read', status: 'error' }]);
});

test('named fields reject lossy contexts and collisions before IO without invoking getters', async () => {
  let calls = 0, getters = 0;
  const flow = process<{ id: string }>().effect('read', async () => { calls++; return ok(1); }, 'current');
  class Context { id = 'a'; }
  for (const context of [new Context(), [], { current: 0 },
    Object.defineProperty({}, 'id', { enumerable: true, get() { getters++; return 'a'; } }),
    Object.defineProperty({}, 'id', { value: 'a' }),
    Object.defineProperty({}, Symbol('hidden'), { value: true }),
  ]) {
    // Simulate an unchecked host caller; these are deliberately outside the declaration contract.
    await assert.rejects(flow.run(context as { id: string }), /EffectField/);
  }
  assert.equal(calls, 0); assert.equal(getters, 0);
  const context = Object.assign(Object.create(null), { id: 'a' });
  assert.deepEqual(await flow.run(context), ok({ id: 'a', current: 1 }));
  assert.equal(calls, 1);
});

test('an IO adapter cannot silently replace a field added while it was running', async () => {
  const input = { id: 'a' }; let later = 0;
  const flow = process<typeof input>()
    .effect('read', async context => { Object.assign(context, { current: 'changed' }); return ok(1); }, 'current')
    .effect('later', async value => { later++; return ok(value); });
  await assert.rejects(flow.run(input), /EffectFieldAlreadyExists/); assert.equal(later, 0);
});

test('concurrent named effects retain each run context and preserve adapter rejections', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const defect = Error('offline');
  const flow = process<{ id: number }>().effect('read', async ({ id }) => {
    if (id < 0) throw defect;
    if (id === 1) await gate;
    return ok(id * 10);
  }, 'current');
  const slow = flow.run({ id: 1 }); assert.deepEqual(await flow.run({ id: 2 }), ok({ id: 2, current: 20 }));
  release(); assert.deepEqual(await slow, ok({ id: 1, current: 10 }));
  await assert.rejects(flow.run({ id: -1 }), cause => cause === defect);
});

test('union field names promise one attached field, and computed prototype names remain data', async () => {
  const key: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
  const flow = process<{ id: string }>().effect('read', async () => ok(1), key);
  type Output = Assert<Equal<Awaited<ReturnType<typeof flow.run>>, Result<
    ({ id: string } & Readonly<{ left: number }>) | ({ id: string } & Readonly<{ right: number }>), never>>>;
  const value = await flow.run({ id: 'a' }); assert(value.ok); assert.equal(Object.hasOwn(value.value, key), true);
  const proto = await process<{ id: string }>().effect('read', async () => ok('value'), '__proto__').run({ id: 'a' });
  assert(proto.ok); assert.equal(Object.getPrototypeOf(proto.value), Object.prototype); assert.equal(proto.value.__proto__, 'value');
});

test('named attachment retains detailed-loader traces and captures the attached output', async () => {
  interface Input { readonly id: number }
  const loader = process<Input>().effect('inside', async ({ id }) => ok(id * 2));
  const flow = process<Input>().effect('read', loader, 'current');
  const report = await flow.runDetailed({ id: 3 }, {
    input: value => structuredClone(value), result: result => result.ok ? structuredClone(result.value) : null,
  });
  assert.deepEqual(report.result, ok({ id: 3, current: 6 }));
  assert.deepEqual(report.trace.map(row => row.step), ['inside', 'read']);
  assert.deepEqual(report.observations.find(row => row.step === 'read')?.result, { id: 3, current: 6 });
});

function rejectedDeclarations() {
  // @ts-expect-error attachment cannot replace an existing context field
  process<{ current: string }>().effect('read', async () => ok(1), 'current');
  // @ts-expect-error fields present in any union member cannot be overwritten
  process<{ id: string } | { current: string }>().effect('read', async () => ok(1), 'current');
  const dynamic: string = 'current';
  // @ts-expect-error a broad string cannot describe a statically known added field
  process<{ id: string }>().effect('read', async () => ok(1), dynamic);
  // @ts-expect-error scalar contexts require the explicit projection form
  process<number>().effect('read', async () => ok(1), 'current');
}
void rejectedDeclarations;
