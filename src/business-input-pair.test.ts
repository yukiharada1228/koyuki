import test from 'node:test';
import assert from 'node:assert/strict';
import { business, withInput, step, ok, err, type Result, type GroupExecution } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
class Context {
  #host = 'trusted';
  constructor(readonly amount: number, readonly currency: string) {}
  host() { return this.#host; }
}
type Pair = Readonly<{ input: Context; value: number }>;
function quote<T extends Base>(input: T): Result<number, 'Declined'> {
  return input.amount > 0 ? ok(input.amount * 2) : err('Declined');
}
const quoted = withInput(quote);

for (const variant of ['inline', 'bound', 'named'] as const) test(`business retains generic input pairs without a context annotation: ${variant}`, async () => {
  let loaded: Context | undefined, saves = 0;
  const stored: string[] = [];
  const load = async (input: number): Promise<Result<Context, 'LoadFailed'>> => {
    if (Number.isNaN(input)) return err('LoadFailed');
    loaded = new Context(input, 'JPY'); return ok(loaded);
  };
  const finish = (pair: Pair) => {
    assert.strictEqual(pair.input, loaded); assert(Object.isFrozen(pair));
    return ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`);
  };
  const save = async (value: string): Promise<Result<string, 'Conflict'>> => {
    saves++; if (value.endsWith(':10')) return err('Conflict'); stored.push(value); return ok(value);
  };
  const config = { name: 'retained', load, save, operations: { quote: [quoted, finish] as const } };
  const app = variant === 'inline'
    ? business({ name: 'retained', load, save, operations: { quote: [quoted, finish] } })
    : variant === 'named'
      ? business({ name: 'retained', load, save, operations: { quote: [step('quote', quoted), finish] } })
      : business(config);
  type Input = Assert<Equal<Parameters<typeof app.quote>[0], number>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.quote>>, Result<string, 'LoadFailed' | 'Declined' | 'Conflict'>>>;
  const success = await app.quote.runDetailed(2, { input: value => typeof value, result: value => value.ok });
  assert.deepEqual(success.result, ok('JPY:trusted:4'));
  assert.deepEqual(success.trace.map(row => row.step), ['retained.quote:load', variant === 'named' ? 'quote' : 'run:1', 'run:2', 'retained.quote']);
  assert.equal(success.observations.length, 4);
  const declined = await app.quote.runDetailed(0);
  assert.deepEqual(declined.result, err('Declined')); assert.equal(declined.trace.length, 2);
  const missing = await app.quote.runDetailed(NaN);
  assert.deepEqual(missing.result, err('LoadFailed')); assert.equal(missing.trace.length, 1);
  const conflict = await app.quote.runDetailed(5);
  assert.deepEqual(conflict.result, err('Conflict')); assert.equal(conflict.trace.at(-1)?.status, 'error');
  assert.equal(saves, 2); assert.deepEqual(stored, ['JPY:trusted:4']);
});

function refusedConnections() {
  const load = async (amount: number) => ok(new Context(amount, 'JPY'));
  const finish = (pair: Pair) => ok(pair.input.host());
  const save = async (value: string) => ok(value);
  const broad = (_input: Context): Result<Readonly<{ input: Base; value: number }>, never> => ok({ input: { amount: 1 }, value: 2 });
  // @ts-expect-error pair shape alone does not prove retention of the loaded context
  business({ name: 'broad', load, save, operations: { quote: [broad, finish] } });
  const incomplete = async (amount: number) => ok<Base>({ amount });
  // @ts-expect-error generic retention cannot manufacture class facts missing from the loaded value
  business({ name: 'incomplete', load: incomplete, save, operations: { quote: [quoted, finish] } });
  const dynamic: typeof quoted | typeof broad = Math.random() < 0.5 ? quoted : broad;
  // @ts-expect-error every possible producer must guarantee the complete next input
  business({ name: 'dynamic', load, save, operations: { quote: [dynamic, finish] } });
}
void refusedConnections;

type CheckedAmount = Readonly<{ amount: number; checked: true }>;
type PlainAmount = Readonly<{ amount: number }>;
function checkAmount<T extends Base>(input: T): Result<CheckedAmount, 'InvalidAmount'> {
  return input.amount > 0 ? ok({ amount: input.amount, checked: true }) : err('InvalidAmount');
}
const checkedAmount = withInput(checkAmount);
function finishAmount<T extends Base>({ input, value }: Readonly<{ input: T; value: CheckedAmount }>): Result<Readonly<{ input: T; value: PlainAmount }>, 'TooLarge'> {
  return value.amount > 10 ? err('TooLarge') : ok(Object.freeze({ input, value: { amount: value.amount } }));
}

test('a pair projection retains the inner context after deliberately dropping an intermediate proof', async () => {
  type FinishedPair = Readonly<{ input: Context; value: PlainAmount }>;
  let saves = 0, loaded: Context | undefined;
  const app = business({ name: 'inner-pair', load: async (amount: number) => { loaded = new Context(amount, 'JPY'); return ok(loaded); },
    save: async <T extends Readonly<{ input: Base; value: PlainAmount }>>(pair: T): Promise<Result<T, 'Conflict'>> => {
      saves++; assert.strictEqual(pair.input, loaded); return ok(pair);
    }, operations: { go: [{ name: 'check', rule: checkedAmount }, { name: 'finish', rule: finishAmount }] },
  });
  type Exact = Assert<Equal<Awaited<ReturnType<typeof app.go>>, Result<FinishedPair, 'InvalidAmount' | 'TooLarge' | 'Conflict'>>>;
  const success = await app.go.runDetailed(2, { input: (_value, name) => name, result: result => result.ok });
  assert(success.result.ok); assert.strictEqual(success.result.value.input, loaded);
  assert.equal(success.result.value.input.host(), 'trusted'); assert(Object.isFrozen(success.result.value));
  assert.deepEqual(success.result.value.value, { amount: 2 }); assert(!('checked' in success.result.value.value));
  assert.deepEqual(success.trace.map(row => row.step), ['inner-pair.go:load', 'check', 'finish', 'inner-pair.go']);
  assert.deepEqual(success.observations.map(row => row.step), success.trace.map(row => row.step));
  const invalid = await app.go.runDetailed(0), tooLarge = await app.go.runDetailed(11);
  assert.deepEqual(invalid.result, err('InvalidAmount')); assert.equal(invalid.trace.length, 2);
  assert.deepEqual(tooLarge.result, err('TooLarge')); assert.equal(tooLarge.trace.length, 3);
  assert.equal(invalid.plan, null); assert.equal(tooLarge.plan, null); assert.equal(saves, 1);
});

test('nested pair refinement does not erase validation facts added to its inner input', async () => {
  type Checked = Base & Readonly<{ validated: true }>;
  function validate<T extends Base>({ input, value }: Readonly<{ input: T; value: CheckedAmount }>): Result<Readonly<{ input: T & Checked; value: PlainAmount }>, never> {
    return ok({ input: { ...input, validated: true }, value: { amount: value.amount } });
  }
  const consume = (pair: Readonly<{ input: Checked; value: PlainAmount }>) => ok(pair.input.validated);
  const app = business({ name: 'inner-validation', load: async (amount: number) => ok<Base>({ amount }), save: async (value: true) => ok(value),
    operations: { go: [checkedAmount, validate, consume] },
  });
  type Exact = Assert<Equal<Awaited<ReturnType<typeof app.go>>, Result<true, 'InvalidAmount'>>>;
  assert.deepEqual(await app.go(1), ok(true)); assert.deepEqual(await app.go(0), err('InvalidAmount'));
});

test('a nested pair producer with a broad input result cannot inherit the caller context', async () => {
  type BroadPair = Readonly<{ input: Base; value: PlainAmount }>;
  const broad = ({ input, value }: Readonly<{ input: Context; value: CheckedAmount }>): Result<BroadPair, never> =>
    ok({ input: { amount: input.amount }, value: { amount: value.amount } });
  const load = async (amount: number) => ok(new Context(amount, 'JPY'));
  const app = business({ name: 'inner-broad', load, save: async <T extends BroadPair>(value: T) => ok(value), operations: { go: [checkedAmount, broad] } });
  type Exact = Assert<Equal<Awaited<ReturnType<typeof app.go>>, Result<BroadPair, 'InvalidAmount'>>>;
  assert.deepEqual(await app.go(1), ok({ input: { amount: 1 }, value: { amount: 1 } }));
  const consume = (pair: Readonly<{ input: Context; value: PlainAmount }>) => ok(pair.input.host());
  if (false) {
    // @ts-expect-error the actual producer must promise the retained context
    business({ name: 'inner-unsafe', load, save: async (value: string) => ok(value), operations: { go: [checkedAmount, broad, consume] } });
    const dynamic = Math.random() < 0.5 ? finishAmount : broad;
    // @ts-expect-error all possible producers must retain the private context
    business({ name: 'inner-union', load, save: async (value: string) => ok(value), operations: { go: [checkedAmount, dynamic, consume] } });
    const incomplete = async (amount: number) => ok<Base>({ amount });
    // @ts-expect-error nested retention cannot invent class facts missing from the loader
    business({ name: 'inner-incomplete', load: incomplete, save: async (value: string) => ok(value), operations: { go: [checkedAmount, finishAmount, consume] } });
  }
});

type Accepted = Readonly<{ state: 'accepted'; receiptId: string }>;
type Returned = Readonly<{ state: 'returned'; reason: string }>;
type ReceiptState = Accepted | Returned;
type Plan<T extends ReceiptState> = Readonly<{ result: T; checks: readonly string[] }>;
type PlanPair = Readonly<{ input: Context; value: Plan<Accepted> }>;
const preparedPlan = withInput((input: Context): Result<Plan<Accepted>, 'InvalidAmount'> => input.amount > 0
  ? ok({ result: { state: 'accepted', receiptId: 'receipt' }, checks: ['receipt'] }) : err('InvalidAmount'));
function stockProjection<T extends ReceiptState>(pair: Readonly<{ input: Context; value: Plan<T> }>): Result<Plan<T>, 'StockRejected'> {
  assert.equal(pair.input.host(), 'trusted');
  return pair.input.amount > 10 ? err('StockRejected') : ok({ ...pair.value, checks: [...pair.value.checks, 'stock'] });
}

test('a named generic projection preserves the preceding plan state and stops before save on failure', async () => {
  let saves = 0;
  const app = business({ name: 'plan-projection', load: async (amount: number) => ok(new Context(amount, 'JPY')),
    save: async <T extends ReceiptState>(value: Plan<T>): Promise<Result<Plan<T>, 'Conflict'>> => { saves++; return ok(value); },
    operations: { receive: [{ name: 'receipt', rule: preparedPlan }, { name: 'stock', rule: stockProjection }] },
  });
  type Exact = Assert<Equal<Awaited<ReturnType<typeof app.receive>>, Result<Plan<Accepted>, 'InvalidAmount' | 'StockRejected' | 'Conflict'>>>;
  const success = await app.receive.runDetailed(2);
  assert.deepEqual(success.result, ok({ result: { state: 'accepted', receiptId: 'receipt' }, checks: ['receipt', 'stock'] }));
  assert.deepEqual(success.trace.map(row => row.step), ['plan-projection.receive:load', 'receipt', 'stock', 'plan-projection.receive']);
  const invalid = await app.receive.runDetailed(0), blocked = await app.receive.runDetailed(11);
  assert.deepEqual(invalid.result, err('InvalidAmount')); assert.equal(invalid.trace.length, 2);
  assert.deepEqual(blocked.result, err('StockRejected')); assert.equal(blocked.trace.length, 3);
  assert.equal(invalid.plan, null); assert.equal(blocked.plan, null); assert.equal(saves, 1);
});

test('plan projection refinement keeps added validation facts and monomorphic outputs remain broad', async () => {
  const load = async (amount: number) => ok(new Context(amount, 'JPY'));
  function checked<T extends ReceiptState>(pair: Readonly<{ input: Context; value: Plan<T> }>): Result<Plan<T> & Readonly<{ checked: true }>, never> {
    return ok({ ...pair.value, checked: true });
  }
  const precise = business({ name: 'checked-plan', load,
    save: async <T extends Plan<ReceiptState> & Readonly<{ checked: true }>>(value: T) => ok(value),
    operations: { receive: [preparedPlan, checked] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof precise.receive>>, Result<Readonly<{ result: Accepted; checks: readonly string[]; checked: true }>, 'InvalidAmount'>>>;
  assert.deepEqual(await precise.receive(1), ok({ result: { state: 'accepted', receiptId: 'receipt' }, checks: ['receipt'], checked: true }));
  const broad = (_pair: PlanPair): Result<Plan<ReceiptState>, never> => ok({ result: { state: 'returned', reason: 'replaced' }, checks: [] });
  const app = business({ name: 'broad-projection', load, save: async <T extends ReceiptState>(value: Plan<T>) => ok(value),
    operations: { receive: [preparedPlan, broad] },
  });
  type Broad = Assert<Equal<Awaited<ReturnType<typeof app.receive>>, Result<Plan<ReceiptState>, 'InvalidAmount'>>>;
  assert.deepEqual(await app.receive(1), ok({ result: { state: 'returned', reason: 'replaced' }, checks: [] }));
  const acceptedOnly = (plan: Plan<Accepted>) => ok(plan.result.receiptId);
  if (false) {
    // @ts-expect-error a broad producer cannot acquire a state from its input or next consumer
    business({ name: 'bad-projection', load, save: async (value: string) => ok(value), operations: { receive: [preparedPlan, broad, acceptedOnly] } });
    const dynamic = Math.random() < 0.5 ? stockProjection : broad;
    // @ts-expect-error every possible projection must guarantee the narrower state
    business({ name: 'union-projection', load, save: async (value: string) => ok(value), operations: { receive: [preparedPlan, dynamic, acceptedOnly] } });
  }
});

test('a final retained pair preserves context through a generic save while broad saves stay broad', async () => {
  const context = new Context(3, 'JPY');
  type BroadPair = Readonly<{ input: Base; value: number }>;
  const load = async (_input: number) => ok(context);
  const app = business({ name: 'final-pair', load,
    save: async <T extends BroadPair>(pair: T): Promise<Result<T, 'Conflict'>> => ok(pair),
    operations: { quote: [quoted] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.quote>>, Result<Pair, 'Declined' | 'Conflict'>>>;
  const result = await app.quote(3); assert(result.ok);
  assert.strictEqual(result.value.input, context); assert.equal(result.value.input.host(), 'trusted');
  const broad = business({ name: 'broad-save', load,
    save: async (pair: BroadPair): Promise<Result<BroadPair, 'Conflict'>> => ok(pair), operations: { quote: [quoted] },
  });
  type BroadOutput = Assert<Equal<Awaited<ReturnType<typeof broad.quote>>, Result<BroadPair, 'Declined' | 'Conflict'>>>;
  assert((await broad.quote(3)).ok);
});

test('loader compatibility preserves a narrower overloaded operation contract', async () => {
  type Request = Readonly<{ id: string }>;
  type Specific = Request & Readonly<{ reason: string }>;
  type Loaded<I> = Readonly<{ input: I; actor: 'host' }>;
  type Narrow = Readonly<{ kind: 'narrow' }>;
  type Wide = Readonly<{ kind: 'narrow' | 'broad' }>;
  function decide(value: Loaded<Request>): Result<Wide, 'InvalidReason'>;
  function decide(value: Loaded<Specific>): Result<Narrow, 'InvalidReason'>;
  function decide(value: Loaded<Request>): Result<Wide, 'InvalidReason'> {
    if ('reason' in value.input) return typeof value.input.reason === 'string' && value.input.reason.trim()
      ? ok({ kind: 'narrow' }) : err('InvalidReason');
    return ok({ kind: 'broad' });
  }
  let saves = 0;
  const load = async <I extends Request>(input: I) => ok<Loaded<I>>({ input, actor: 'host' });
  const app = business({ name: 'overloaded', load, save: async (value: Narrow) => { saves++; return ok(value); }, operations: { decide: [decide] } });
  type Input = Assert<Equal<Parameters<typeof app.decide>[0], Specific>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.decide>>, Result<Narrow, 'InvalidReason'>>>;
  assert.deepEqual(await app.decide({ id: 'one', reason: 'allowed' }), ok({ kind: 'narrow' }));
  assert.deepEqual(await app.decide({ id: 'one', reason: '' }), err('InvalidReason')); assert.equal(saves, 1);
  if (false) {
    // @ts-expect-error the broad callable must not erase the operation's required reason
    app.decide({ id: 'one' });
  }
  function always(value: Loaded<Request>): Result<true, never>;
  function always(value: Loaded<Specific>): Result<true, never>;
  function always(_value: Loaded<Request>): Result<true, never> { return ok(true); }
  const metadata = business({ name: 'overloaded-metadata', load,
    save: async (value: true, execution: GroupExecution<'go', Specific>) => {
      assert.equal(execution.request.reason, 'required'); return ok(value);
    }, operations: { go: [always] },
  });
  type MetadataInput = Assert<Equal<Parameters<typeof metadata.go>[0], Specific>>;
  assert.deepEqual(await metadata.go({ id: 'one', reason: 'required' }), ok(true));
});

test('pair refinement preserves validation facts added by a normal domain function', async () => {
  type Checked = Base & Readonly<{ validated: true }>;
  type CheckedPair = Readonly<{ input: Checked; value: number }>;
  const validate = (input: Base): Result<CheckedPair, 'InvalidAmount'> => input.amount > 0
    ? ok({ input: { ...input, validated: true }, value: input.amount * 2 }) : err('InvalidAmount');
  const consume = (pair: CheckedPair) => ok(pair.input.validated);
  const app = business({ name: 'validated-pair', load: async (amount: number) => ok<Base>({ amount }),
    save: async (value: true) => ok(value), operations: { go: [validate, consume] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.go>>, Result<true, 'InvalidAmount'>>>;
  assert.deepEqual(await app.go(1), ok(true)); assert.deepEqual(await app.go(0), err('InvalidAmount'));
});
