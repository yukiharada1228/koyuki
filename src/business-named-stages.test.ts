import test from 'node:test';
import assert from 'node:assert/strict';
import { business, step, withInput, describeFlow, ok, err, type Result, type Step, type Execution, type Receipt, type ReplayInputError } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
class Context {
  #host = 'trusted';
  constructor(readonly amount: number, readonly currency: string) {}
  host() { return this.#host; }
}
function quote(value: Context): Result<number, 'Declined'> { return value.amount > 0 ? ok(value.amount * 2) : err('Declined'); }
type Pair = Readonly<{ input: Context; value: number }>;

test('business accepts an inline named step and preserves concrete withInput context', async () => {
  let loaded: Context | undefined, finished = 0, saves = 0;
  const app = business({ name: 'named',
    load: async (amount: number): Promise<Result<Context, 'NotFound'>> => { loaded = new Context(amount, 'JPY'); return ok(loaded); },
    operations: { quote: [step('calculate-quote', withInput((value: Context) => quote(value))), (pair: Pair) => {
      finished++; assert.strictEqual(pair.input, loaded); return ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`);
    }] },
    save: async (value: string): Promise<Result<string, 'Conflict'>> => { saves++; return ok(value); },
  });
  type Input = Assert<Equal<Parameters<typeof app.quote>[0], number>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.quote>>, Result<string, 'NotFound' | 'Declined' | 'Conflict'>>>;
  const success = await app.quote.runDetailed(10);
  assert.deepEqual(success.result, ok('JPY:trusted:20'));
  assert.deepEqual(success.trace.map(row => [row.step, row.status]), [['named.quote:load', 'ok'], ['calculate-quote', 'ok'], ['run:2', 'ok'], ['named.quote', 'ok']]);
  const failure = await app.quote.runDetailed(0);
  assert.deepEqual(failure.result, err('Declined'));
  assert.deepEqual(failure.trace.map(row => [row.step, row.status]), [['named.quote:load', 'ok'], ['calculate-quote', 'error']]);
  assert.equal(finished, 1); assert.equal(saves, 1);
});

test('named stage metadata is captured once and used by trace and selected observations', async () => {
  let nameReads = 0, ruleReads = 0, loads = 0, name = 'checked', rule = (value: number): Result<number, 'Denied'> => ok(value + 1);
  const declared: Step<number, number, 'Denied'> = {
    get name() { nameReads++; return name; }, get rule() { ruleReads++; return rule; },
  };
  const app = business({ name: 'captured', load: async (value: number) => { loads++; return ok(value); }, save: async (value: number) => ok(value),
    operations: { increment: [declared] },
  });
  assert.equal(nameReads, 1); assert.equal(ruleReads, 1);
  name = 'changed'; rule = () => err('Denied');
  assert.deepEqual(describeFlow(app.increment).nodes.map(node => node.name), ['captured.increment:load', 'checked', 'captured.increment']);
  assert.equal(loads, 0);
  const hooks: string[] = [];
  const report = await app.increment.runDetailed(2, {
    input: (_value, stage) => { hooks.push(`in:${stage}`); return stage; },
    result: (result, stage) => { hooks.push(`out:${stage}`); return result.ok; },
  });
  assert.deepEqual(report.result, ok(3));
  assert.deepEqual(report.trace.map(row => row.step), ['captured.increment:load', 'checked', 'captured.increment']);
  assert.deepEqual(report.observations.map(row => row.step), report.trace.map(row => row.step));
  assert.deepEqual(hooks, report.trace.flatMap(row => [`in:${row.step}`, `out:${row.step}`]));
  assert.equal(nameReads, 1); assert.equal(ruleReads, 1);
  assert(describeFlow(app.increment, report.trace).nodes.every(node => node.match === 'ok'));
});

test('named first stages specialize a generic loader for operation-specific requests', async () => {
  type Input = Readonly<{ id: string; reason: string }>;
  type Loaded<I> = Readonly<{ input: I; actor: string }>;
  const load = async <I extends { id: string }>(input: I): Promise<Result<Loaded<I>, 'Missing'>> => ok({ input, actor: 'host' });
  const decide = (value: Loaded<Input>): Result<string, 'InvalidReason'> => value.input.reason ? ok(value.actor + ':' + value.input.reason) : err('InvalidReason');
  const app = business({ name: 'local-named', save: async (value: string) => ok(value),
    operations: { reject: { load, run: [step('reject', decide)] } },
  });
  type Request = Assert<Equal<Parameters<typeof app.reject>[0], Input>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.reject>>, Result<string, 'Missing' | 'InvalidReason'>>>;
  assert.deepEqual(await app.reject({ id: 'one', reason: 'policy' }), ok('host:policy'));
  assert.deepEqual((await app.reject.runDetailed({ id: 'one', reason: '' })).trace.map(row => [row.step, row.status]), [['local-named.reject:load', 'ok'], ['reject', 'error']]);
});

test('named stage exceptions preserve their cause and stop later stages and save', async () => {
  const cause = new Error('RuleDefect'); let later = 0, saves = 0;
  const app = business({ name: 'defect', load: async (value: number) => ok(value),
    operations: { run: [step('broken', (_value: number): Result<number, never> => { throw cause; }), (value: number) => { later++; return ok(value); }] },
    save: async (value: number) => { saves++; return ok(value); },
  });
  await assert.rejects(app.run.runDetailed(1), error => error === cause);
  assert.equal(later, 0); assert.equal(saves, 0);
});

test('named stages retain the existing replay boundary without rerunning a completed decision', async () => {
  let stored: number | null = null, decisions = 0, saves = 0;
  const app = business({ name: 'replay-named', load: async (value: number) => ok(value),
    operations: { increment: [step('increment', (value: number): Result<number, 'Denied'> => { decisions++; return ok(value + 1); })] },
    save: async (value: number): Promise<Result<Execution<number>, 'Conflict'>> => { saves++; stored = value; return ok({ kind: 'committed', value }); },
    replay: { lookup: (): Result<Receipt<number>, 'Unavailable'> => ok(stored === null ? { kind: 'missing' } : { kind: 'found', value: stored }), resolveAfter: [] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.increment>>, Result<Execution<number>, 'Denied' | 'Conflict' | 'Unavailable' | ReplayInputError>>>;
  assert.deepEqual(await app.increment(2), ok({ kind: 'committed', value: 3 }));
  assert.deepEqual(await app.increment(2), ok({ kind: 'replayed', value: 3 }));
  assert.equal(decisions, 1); assert.equal(saves, 1);
});

test('a callable Step cannot silently replace the named rule with a different outer body', () => {
  const hybrid = Object.assign((_value: number): Result<string, never> => ok('wrong'), { rule: (value: number) => ok(value + 1) });
  const declared: Step<number, number, never> = hybrid;
  assert.throws(() => business({ name: 'ambiguous', load: async (value: number) => ok(value), save: async (value: number) => ok(value), operations: { run: [declared] } }), /AmbiguousBusinessStage/);
});

test('malformed JavaScript stage declarations fail before loading or saving', () => {
  let effects = 0;
  for (const declaration of [null, 1, {}, { name: 1, rule: (value: number) => ok(value) }, { name: 'invalid', rule: 1 }]) {
    assert.throws(() => Reflect.apply(business, undefined, [{ name: 'invalid',
      load: async (value: number) => { effects++; return ok(value); },
      save: async (value: number) => { effects++; return ok(value); },
      operations: { run: [declaration] },
    }]), /BusinessRequiresRule/);
  }
  assert.equal(effects, 0);
});

declare const permitted: unique symbol;
type Permitted = Context & { readonly [permitted]: true };
declare const approve: (value: Permitted) => Result<string, 'Closed'>;
declare const permit: (value: Context) => Result<Permitted, 'Denied'>;
declare const disguised: Step<Permitted, string, 'Closed'> & { readonly 'Koyuki: approve[0] input must accept prior output': never };
declare const selected: Step<Permitted, string, 'Closed'> | Step<Context, string, never>;
function typeContracts() {
  const load = async (amount: number) => ok(new Context(amount, 'JPY'));
  const save = async (value: string) => ok(value);
  const valid = business({ name: 'permitted', load, save, operations: { approve: [permit, step('approve', approve)] } });
  type Valid = Assert<Equal<Awaited<ReturnType<typeof valid.approve>>, Result<string, 'Denied' | 'Closed'>>>;
  business({ name: 'missing', load, save, operations: {
    // @ts-expect-error naming a step cannot create a missing permission proof
    approve: [step('approve', approve)],
  } });
  business({ name: 'disguised', load, save, operations: {
    // @ts-expect-error a diagnostic marker still cannot replace the actual rule input contract
    approve: [disguised],
  } });
  business({ name: 'output', load, save, operations: {
    // @ts-expect-error a named rule's success value must match the save boundary
    quote: [step('quote', quote)],
  } });
  business({ name: 'dynamic', load, save, operations: {
    // @ts-expect-error every candidate named rule must accept the loaded context
    approve: [selected],
  } });
}
void typeContracts;
