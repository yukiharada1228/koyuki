import test from 'node:test';
import assert from 'node:assert/strict';
import { business, withInput, ok, err, type Result } from './framework/index.js';
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

for (const variant of ['inline', 'bound'] as const) test(`business retains generic input pairs without a context annotation: ${variant}`, async () => {
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
    : business(config);
  type Input = Assert<Equal<Parameters<typeof app.quote>[0], number>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.quote>>, Result<string, 'LoadFailed' | 'Declined' | 'Conflict'>>>;
  const success = await app.quote.runDetailed(2, { input: value => typeof value, result: value => value.ok });
  assert.deepEqual(success.result, ok('JPY:trusted:4'));
  assert.deepEqual(success.trace.map(row => row.step), ['retained.quote:load', 'run:1', 'run:2', 'retained.quote']);
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
