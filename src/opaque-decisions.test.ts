import test from 'node:test';
import assert from 'node:assert/strict';
import { business, bindMutation, defineCommand, workflow, ok, err, type Result, type Execution, type Receipt } from './framework/index.js';
type View = ReturnType<ReturnType<typeof bindMutation>['view']>;
type Save = (value: unknown) => Promise<Result<unknown, 'StoreFailed'>>;
const decide = (value: unknown) => ok(value);
const load = async (value: unknown) => ok(value);
const builders = {
  binding: (save: Save) => bindMutation({ workflow: workflow('decide', decide), operation: 'opaque', save }),
  command: (save: Save) => defineCommand({ operation: 'opaque', load, decide: workflow('decide', decide), save }),
  business: (save: Save) => business({ name: 'opaque', operation: () => 'opaque', load, save, operations: { change: [decide] } }).change,
};
const unavailable = { kind: 'write', operation: 'opaque', inputStatus: 'unavailable' };
for (const [name, build] of Object.entries(builders)) {
  test(`opaque domain values reach save unchanged / ${name}`, async () => {
    const proof = Symbol('proof'); let functionCalls = 0;
    class Domain {
      #amount = 7;
      amount() { return this.#amount; }
    }
    class DomainArray extends Array<number> { #label = 'domain'; label() { return this.#label; } }
    const sparseWithMetadata: unknown[] = []; sparseWithMetadata.length = 1; Object.assign(sparseWithMetadata, { '4294967295': 2 });
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    const hidden = Object.defineProperty({ id: 1 }, 'secret', { value: 'hidden-secret' });
    const callable = () => { functionCalls++; return 2; };
    const values: unknown[] = [
      { amount: 2, [proof]: true }, Symbol('value'), new Domain(), new DomainArray(1, 2), callable, cycle, hidden, sparseWithMetadata,
      Object.assign([1], { tag: 'opaque' }), Object.assign([1], { [proof]: true }),
      2n, new Date('2026-01-01'), new Map([['amount', 2]]), { value: undefined }, [1, , 3],
    ];
    let saves = 0;
    const command = build(async value => { saves++; return ok(value); });
    for (const value of values) {
      const report = await command.runDetailed(value); assert(report.result.ok);
      assert.strictEqual(report.result.value, value); assert.deepEqual(report.plan, unavailable);
      assert.deepEqual(report.trace.at(-1), { step: 'opaque', status: 'ok' });
      const result = await command.run(value); assert(result.ok); assert.strictEqual(result.value, value);
    }
    assert.equal(saves, values.length * 2); assert.equal(functionCalls, 0);
    const instance = values[2]; assert(instance instanceof Domain); assert.equal(instance.amount(), 7);
    const array = values[3]; assert(array instanceof DomainArray); assert.equal(array.label(), 'domain');
  });
  test(`diagnostics do not invoke domain accessors / ${name}`, async () => {
    let gets = 0, saves = 0;
    const value = { get amount(): number { gets++; throw new Error('GetterMustNotRun'); } };
    const command = build(async actual => { saves++; assert.strictEqual(actual, value); return ok(actual); });
    const report = await command.runDetailed(value); assert(report.result.ok);
    assert.strictEqual(report.result.value, value); assert.deepEqual(report.plan, unavailable);
    assert.equal(gets, 0); assert.equal(saves, 1);
  });
  test(`diagnostic inspection and cloning failures cannot cancel save / ${name}`, async () => {
    const broken = new Proxy({ amount: 2 }, { ownKeys() { throw new Error('private-diagnostic-message'); } });
    const transparent = new Proxy({ amount: 2 }, {}); // structuredClone rejects Proxy instances.
    let saves = 0;
    const command = build(async actual => { saves++; return ok(actual); });
    for (const value of [broken, transparent]) {
      const report = await command.runDetailed(value); assert(report.result.ok);
      assert.strictEqual(report.result.value, value); assert.deepEqual(report.plan, unavailable);
      assert(!JSON.stringify(report.plan).includes('private-diagnostic-message'));
    }
    assert.equal(saves, 2);
  });
  test(`plain diagnostic snapshots preserve aliases and remain separate from the live decision / ${name}`, async () => {
    const shared = { amount: 2 }, value = { left: shared, right: shared };
    let saves = 0;
    const report = await build(async actual => { saves++; assert.strictEqual(actual, value); shared.amount = 99; return ok(actual); }).runDetailed(value);
    assert(report.result.ok); assert.strictEqual(report.result.value, value); assert.equal(saves, 1);
    assert.deepEqual(report.plan, { kind: 'write', operation: 'opaque', input: { left: { amount: 2 }, right: { amount: 2 } } });
    const plan = report.plan as { input: { left: { amount: number }; right: { amount: number } } };
    assert.strictEqual(plan.input.left, plan.input.right); assert.notStrictEqual(plan.input.left, shared);
    plan.input.left.amount = -1; assert.equal(shared.amount, 99);
  });
  test(`opaque decisions preserve expected failures and unexpected save defects / ${name}`, async () => {
    const value = { [Symbol('proof')]: true }; let saves = 0;
    const failed = await build(async () => { saves++; return err('StoreFailed'); }).runDetailed(value);
    assert.deepEqual(failed.result, err('StoreFailed')); assert.deepEqual(failed.plan, unavailable);
    assert.deepEqual(failed.trace.at(-1), { step: 'opaque', status: 'error' }); assert.equal(saves, 1);
    await assert.rejects(build(async () => { throw new Error('StorageDefect'); }).run(value), /StorageDefect/);
  });
}

test('selected observations can inspect the actual symbol proof without cloning opaque values', async () => {
  const proof = Symbol('proof'); let saves = 0;
  type Domain = { amount: number; [proof]: true };
  const app = business({ name: 'observed', load: async (n: number) => ok(n),
    save: async (value: Domain) => { saves++; assert(value[proof]); return ok(value.amount); },
    operations: { change: [(n: number): Result<Domain, never> => ok({ amount: n, [proof]: true })] },
  });
  const report = await app.change.runDetailed(2, {
    input: value => typeof value === 'object' && value !== null && proof in value && value[proof] === true,
    result: value => value.ok,
  });
  assert.deepEqual(report.result, ok(2)); assert.equal(saves, 1);
  assert.deepEqual(report.plan, { kind: 'write', operation: 'observed.change', inputStatus: 'unavailable' });
  assert.deepEqual(report.observations.map(value => value.input), [false, false, true]);
  assert.equal(report.observationErrors.length, 0);
});

test('JSON requests can produce opaque decisions while replay keeps its original snapshot boundary', async () => {
  const proof = Symbol('proof'); let saves = 0, decisions = 0; let receipt: number | null = null;
  type Domain = { amount: number; [proof]: true };
  const app = business({ name: 'replayed-opaque', load: async (n: number) => ok(n),
    save: async (value: Domain): Promise<Result<Execution<number>, never>> => { saves++; assert(value[proof]); receipt = value.amount; return ok({ kind: 'committed', value: value.amount }); },
    replay: { lookup: async (): Promise<Result<Receipt<number>, never>> => ok(receipt === null ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: [] },
    operations: { change: [(n: number): Result<Domain, never> => { decisions++; return ok({ amount: n, [proof]: true }); }] },
  });
  const first = await app.change.runDetailed(2), repeated = await app.change.runDetailed(2);
  assert.deepEqual(first.result, ok({ kind: 'committed', value: 2 })); assert(first.attempt);
  assert.deepEqual(first.attempt.plan, { kind: 'write', operation: 'replayed-opaque.change', inputStatus: 'unavailable' });
  assert.deepEqual(repeated.result, ok({ kind: 'replayed', value: 2 })); assert.equal(repeated.attempt, null);
  assert.equal(saves, 1); assert.equal(decisions, 1);
  let lookups = 0, loads = 0;
  type Request = { amount: number; callback: () => void };
  const guarded = business({ name: 'guarded', load: async (input: Request) => { loads++; return ok(input.amount); },
    save: async (value: number): Promise<Result<Execution<number>, never>> => ok({ kind: 'committed', value }),
    replay: { lookup: async (): Promise<Result<Receipt<number>, never>> => { lookups++; return ok({ kind: 'missing' }); }, resolveAfter: [] },
    operations: { change: [(value: number) => ok(value)] },
  });
  assert.deepEqual(await guarded.change({ amount: 2, callback: () => {} }), err({ kind: 'ReplayInputNotCloneable' }));
  assert.equal(lookups, 0); assert.equal(loads, 0);
});

test('explicit renderers retain their binding and JSON decision checks', async () => {
  let saves = 0;
  const command = bindMutation({ workflow: workflow('decide', decide), operation: 'rendered',
    save: async (value: unknown) => { saves++; return ok(value); }, render: (value): View => command.Save({ value }),
  });
  await assert.rejects(command.run({ [Symbol('proof')]: true }), /SymbolInput/);
  assert.equal(saves, 0);
});
