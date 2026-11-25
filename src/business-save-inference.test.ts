import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, type Result, type Execution, type Receipt, type GroupExecution } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Draft = Readonly<{ state: 'draft'; amount: number }>;
type Approved = Readonly<{ state: 'approved'; by: string }>;
type State = Draft | Approved;
type Plan<T> = Readonly<{ result: T; writes: readonly T[] }>;
const draft = (amount: number): Draft => ({ state: 'draft', amount });
const approved = (): Approved => ({ state: 'approved', by: 'boss' });
const load = async (n: number): Promise<Result<number, 'NotFound'>> => n < 0 ? err('NotFound') : ok(n);
const create = (n: number): Result<Draft, 'InvalidAmount'> => n === 0 ? err('InvalidAmount') : ok(draft(n));
const approve = (_n: number): Result<Approved, never> => ok(approved());

test('one generic identity save retains each operation result and all failure types', async () => {
  const saved: State[] = [];
  const save = async <T extends State>(value: T): Promise<Result<T, 'StorageFailed'>> => {
    if (value.state === 'draft' && value.amount === 13) return err('StorageFailed');
    saved.push(value); return ok(value);
  };
  const app = business({ name: 'identity', load, save, operations: { create: [create], approve: [approve] } });
  type Create = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Draft, 'NotFound' | 'InvalidAmount' | 'StorageFailed'>>>;
  type Approve = Assert<Equal<Awaited<ReturnType<typeof app.approve.run>>, Result<Approved, 'NotFound' | 'StorageFailed'>>>;
  type Detail = Assert<Equal<Awaited<ReturnType<typeof app.create.runDetailed>>['result'], Result<Draft, 'NotFound' | 'InvalidAmount' | 'StorageFailed'>>>;
  assert.deepEqual(await app.create(2), ok(draft(2)));
  assert.deepEqual(await app.approve.run(2), ok(approved()));
  assert.deepEqual((await app.create.runDetailed(3)).result, ok(draft(3)));
  assert.deepEqual(await app.create(-1), err('NotFound'));
  assert.deepEqual(await app.create(0), err('InvalidAmount'));
  assert.deepEqual(await app.create(13), err('StorageFailed'));
  assert.equal(saved.length, 3);
});

test('generic saves retain additional validation proof beyond the shared state union', async () => {
  const proof: unique symbol = Symbol('validated');
  type Validated = Draft & { readonly [proof]: true };
  // The symbol is a phantom type proof: only this checked constructor creates it.
  const validate = (n: number): Result<Validated, 'Invalid'> => n > 0 ? ok(draft(n) as Validated) : err('Invalid');
  const identity = async <T extends State>(value: T): Promise<Result<T, never>> => ok(value);
  const project = async <T extends State>(plan: Plan<T>): Promise<Result<T, never>> => ok(plan.result);
  const envelope = async <T extends State>(plan: Plan<T>): Promise<Result<{ result: T }, never>> => ok({ result: plan.result });
  const plan = (value: Validated): Result<Plan<Validated>, never> => ok({ result: value, writes: [value] });
  const direct = business({ name: 'proof-direct', load, save: identity, operations: { create: [validate] } });
  const projected = business({ name: 'proof-project', load, save: project, operations: { create: [validate, plan] } });
  const wrapped = business({ name: 'proof-envelope', load, save: envelope, operations: { create: [validate, plan] } });
  type Direct = Assert<Equal<Awaited<ReturnType<typeof direct.create>>, Result<Validated, 'NotFound' | 'Invalid'>>>;
  type Projected = Assert<Equal<Awaited<ReturnType<typeof projected.create>>, Result<Validated, 'NotFound' | 'Invalid'>>>;
  type Wrapped = Assert<Equal<Awaited<ReturnType<typeof wrapped.create>>, Result<{ result: Validated }, 'NotFound' | 'Invalid'>>>;
  const a = await direct.create(2), b = await projected.create(2), c = await wrapped.create(2);
  assert(a.ok && b.ok && c.ok); assert.deepEqual(a.value, draft(2)); assert.deepEqual(b.value, draft(2)); assert.deepEqual(c.value.result, draft(2));
  assert.deepEqual(await direct.create(0), err('Invalid')); assert.deepEqual(await projected.create(0), err('Invalid')); assert.deepEqual(await wrapped.create(0), err('Invalid'));
});

test('runtime symbol attributes reach save while the diagnostic plan reports unavailable input', async () => {
  const proof = Symbol('runtime-proof'); let saves = 0;
  const save = async <T extends State>(value: T): Promise<Result<T, never>> => { saves++; return ok(value); };
  const app = business({ name: 'symbol', load, save, operations: { create: [(n: number) => ok({ ...draft(n), [proof]: true as const })] } });
  const report = await app.create.runDetailed(2);
  assert(report.result.ok); assert.equal(report.result.value[proof], true); assert.equal(saves, 1);
  assert.deepEqual(report.plan, { kind: 'write', operation: 'symbol.create', inputStatus: 'unavailable' });
});

test('generic projection save preserves the direct result field and request context', async () => {
  type RecordPlan<T> = Readonly<{ record: T; writes: readonly T[] }>;
  type Context = GroupExecution<'create' | 'approve', number>;
  const contexts: Context[] = [];
  const save = async <T extends State>(plan: RecordPlan<T>, context: Context): Promise<Result<T, 'Conflict'>> => {
    contexts.push(context); return ok(plan.record);
  };
  const app = business({ name: 'projection', load, save, operations: {
    create: [(n: number) => ok<RecordPlan<Draft>>({ record: draft(n), writes: [draft(n)] })],
    approve: [(n: number) => ok<RecordPlan<Approved>>({ record: approved(), writes: [approved()] })],
  } });
  type Create = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Draft, 'NotFound' | 'Conflict'>>>;
  type Approve = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Approved, 'NotFound' | 'Conflict'>>>;
  assert.deepEqual(await app.create(2), ok(draft(2)));
  const report = await app.approve.runDetailed(4, { input: value => String(typeof value), result: value => value.ok });
  type Observation = Assert<Equal<typeof report.observations[number]['input'], string>>;
  assert.deepEqual(report.result, ok(approved()));
  assert.deepEqual(contexts.map(value => [value.name, value.request]), [['create', 2], ['approve', 4]]);
});

test('generic save envelopes preserve aligned fields and additional saved metadata', async () => {
  type Stored<T> = Readonly<{ result: T; receiptId: string }>;
  const save = async <T extends State>(plan: Plan<T>): Promise<Result<Stored<T>, 'StoreFailed'>> => ok({ result: plan.result, receiptId: 'receipt-1' });
  const app = business({ name: 'envelope', load, save, operations: {
    create: [(n: number) => ok<Plan<Draft>>({ result: draft(n), writes: [] })],
    approve: [(n: number) => ok<Plan<Approved>>({ result: approved(), writes: [] })],
  } });
  type Create = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Stored<Draft>, 'NotFound' | 'StoreFailed'>>>;
  type Approve = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Stored<Approved>, 'NotFound' | 'StoreFailed'>>>;
  assert.deepEqual(await app.create(2), ok({ result: draft(2), receiptId: 'receipt-1' }));
  assert.deepEqual(await app.approve(2), ok({ result: approved(), receiptId: 'receipt-1' }));
});

test('mapped refinement does not erase private class identity', async () => {
  class Stored<T> {
    private readonly token = Symbol('stored');
    constructor(readonly result: T) {}
    valid() { return typeof this.token === 'symbol'; }
  }
  const save = async <T extends State>(plan: Plan<T>): Promise<Result<Stored<T>, never>> => ok(new Stored(plan.result));
  const app = business({ name: 'class', load, save, operations: { create: [(n: number) => ok<Plan<Draft>>({ result: draft(n), writes: [] })] } });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Stored<State>, 'NotFound'>>>;
  const result = await app.create(2); assert(result.ok); assert(result.value instanceof Stored); assert(result.value.valid());
});

test('the final stage and a custom loader determine each operation contract', async () => {
  const save = async <T extends State>(value: T): Promise<Result<T, 'SaveFailed'>> => ok(value);
  const permit = (value: Draft): Result<Approved, 'Denied'> => value.amount > 10 ? err('Denied') : ok(approved());
  const app = business({ name: 'custom', load, save, operation: name => {
    const exact: 'create' | 'approve' = name; return `custom.${exact}`;
  }, operations: {
    create: [create],
    approve: { load: async (text: string): Promise<Result<number, 'InvalidText'>> => /^\d+$/.test(text) ? ok(Number(text)) : err('InvalidText'), run: [create, permit] },
  } });
  type Input = Assert<Equal<Parameters<typeof app.approve>[0], string>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Approved, 'InvalidText' | 'InvalidAmount' | 'Denied' | 'SaveFailed'>>>;
  assert.deepEqual(await app.approve('2'), ok(approved()));
  assert.deepEqual(await app.approve('12'), err('Denied'));
  assert.deepEqual(await app.approve('bad'), err('InvalidText'));
  assert.deepEqual((await app.approve.runDetailed('2')).trace.map(entry => entry.step), ['custom.approve:load', 'run:1', 'run:2', 'custom.approve']);
});

test('a broad save may replace the decision value and must keep its full declared union', async () => {
  const save = async (_value: Draft): Promise<Result<State, 'Failed'>> => ok(approved());
  const app = business({ name: 'replace', load, save, operations: { create: [create] } });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<State, 'NotFound' | 'InvalidAmount' | 'Failed'>>>;
  assert.deepEqual(await app.create(2), ok(approved()));
  const genericBroad = async <T extends State>(_plan: Plan<T>): Promise<Result<State, 'Failed'>> => ok(approved());
  const broad = business({ name: 'broad', load, save: genericBroad, operations: { create: [(n: number) => ok<Plan<Draft>>({ result: draft(n), writes: [] })] } });
  type GenericOutput = Assert<Equal<Awaited<ReturnType<typeof broad.create>>, Result<State, 'NotFound' | 'Failed'>>>;
  assert.deepEqual(await broad.create(2), ok(approved()));
});

test('non-projecting saves retain their own transformed output shape', async () => {
  const save = async (_value: State): Promise<Result<{ stored: true; revision: number }, never>> => ok({ stored: true, revision: 1 });
  const app = business({ name: 'transform', load, save, operations: { create: [create], approve: [approve] } });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<{ stored: true; revision: number }, 'NotFound' | 'InvalidAmount'>>>;
  assert.deepEqual(await app.create(2), ok({ stored: true, revision: 1 }));
});

test('legacy save callbacks retain contextual operation names and request types', async () => {
  const app = business({ name: 'context', load, save: async (value: Draft, execution) => {
    const name: 'create' = execution.name, request: number = execution.request;
    if (false) {
      // @ts-expect-error contextual metadata must not become any
      execution.request.missing;
    }
    assert.equal(name, 'create'); assert.equal(request, 2); return ok(value);
  }, operations: { create: [create] } });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Draft, 'NotFound' | 'InvalidAmount'>>>;
  assert.deepEqual(await app.create(2), ok(draft(2)));
});

test('replay keeps historical output alternatives beyond the current decision', async () => {
  type SavedExecution = Execution<Draft> | Execution<Approved>;
  const save = async <T extends SavedExecution>(value: T): Promise<Result<T, 'Conflict'>> => ok(value);
  const cached: Receipt<State> = { kind: 'found', value: approved() };
  const app = business({ name: 'historical', load, save, replay: { lookup: async () => ok(cached), resolveAfter: [] }, operations: {
    create: [(n: number) => ok<Execution<Draft>>({ kind: 'committed', value: draft(n) })],
  } });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Execution<State>, 'NotFound' | 'Conflict' | import('./framework/index.js').ReplayInputError>>>;
  assert.deepEqual(await app.create(2), ok({ kind: 'replayed', value: approved() }));
});

function invalidDefinitions() {
  const save = async <T extends State>(plan: Plan<T>): Promise<Result<T, 'Conflict'>> => ok(plan.result);
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error a generic save still requires the complete write-plan input
    create: [create],
  } });
  const narrowContext = async <T extends State>(plan: Plan<T>, _context: GroupExecution<'other', number>): Promise<Result<T, never>> => ok(plan.result);
  // @ts-expect-error generic saving cannot require metadata from an unrelated operation
  business({ name: 'bad-context', load, save: narrowContext, operations: { create: [(n: number) => ok<Plan<Draft>>({ result: draft(n), writes: [] })] } });
  const syncSave = <T extends State>(value: T) => ok(value);
  // @ts-expect-error the shared saving boundary remains asynchronous
  business({ name: 'sync', load, save: syncSave, operations: { create: [create] } });
}
void invalidDefinitions;
