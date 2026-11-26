import test from 'node:test';
import assert from 'node:assert/strict';
import { business, workflow, step, withInput, describeFlow, defineApplication, operation, ok, err, type Result, type Execution, type Receipt, type ExecutionEvent } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
class Context { #currency = 'JPY'; constructor(readonly amount: number) {} currency() { return this.#currency; } }
const quoted = workflow('quote', withInput((value: Context): Result<number, 'Declined'> => value.amount > 0 ? ok(value.amount * 2) : err('Declined')))
  .then('format', ({ input, value }) => ok(`${input.currency()}:${value}`));

test('explicit Workflow business stages preserve inferred callbacks, inner traces and selected captures', async () => {
  let loads = 0, saves = 0;
  const app = business({ name: 'grouped', load: async (amount: number): Promise<Result<Context, 'NotFound'>> => { loads++; return ok(new Context(amount)); },
    operations: { quote: [step('check', (value: Context) => ok(value)), quoted, (value: string) => ok(`${value}!`)] },
    save: async (value: string): Promise<Result<string, 'Conflict'>> => { saves++; return ok(value); },
  });
  type Input = Assert<Equal<Parameters<typeof app.quote>[0], number>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.quote>>, Result<string, 'NotFound' | 'Declined' | 'Conflict'>>>;
  const labels = ['grouped.quote:load', 'check', 'quote', 'format', 'run:3', 'grouped.quote'];
  assert.deepEqual(describeFlow(app.quote).nodes.map(node => node.name), labels); assert.equal(loads, 0);
  const report = await app.quote.runDetailed(2, { input: (_value, name) => name, result: value => value.ok });
  assert.deepEqual(report.result, ok('JPY:4!')); assert.deepEqual(report.trace.map(row => row.step), labels);
  assert.deepEqual(report.observations.map(row => row.step), labels); assert.deepEqual(report.observationErrors, []);
  const failed = await app.quote.runDetailed(0);
  assert.deepEqual(failed.result, err('Declined')); assert.deepEqual(failed.trace.map(row => row.step), labels.slice(0, 3)); assert.equal(failed.plan, null);
  assert.equal(loads, 2); assert.equal(saves, 1);
});

test('a first Workflow keeps a generic loader specialized to the operation request', async () => {
  type Request = { id: string; reason: string };
  const load = async <I extends { id: string }>(input: I) => ok({ input, actor: 'trusted' });
  const reject = workflow('reject', (value: { input: Request; actor: string }): Result<string, 'Denied'> => ok(`${value.actor}:${value.input.reason}`));
  const app = business({ name: 'first', load, save: async (value: string) => ok(value), operations: { reject: [reject] } });
  type Input = Assert<Equal<Parameters<typeof app.reject>[0], Request>>;
  assert.deepEqual(await app.reject({ id: 'a', reason: 'reason' }), ok('trusted:reason'));
});

test('Workflow branches keep selected traces and live spans within the same Application execution', async () => {
  const events: ExecutionEvent[] = [];
  const choice = workflow('start', (value: number) => ok(value)).branch('direction', value => value >= 0, {
    yes: workflow('positive', (value: number) => ok(value + 1)),
    no: workflow('negative', (_value: number): Result<number, 'Denied'> => err('Denied')),
  });
  const commands = business({ name: 'branch', load: async (value: number) => ok(value), save: async (value: number) => ok(value), operations: { apply: [choice] } });
  const app = defineApplication({ initial: () => 0, operations: { apply: operation(commands.apply, (_: number, value) => value) }, view: state => state.data });
  const session = await app.start({ sessionId: 'grouped', observeExecution: event => events.push(event) });
  const result = await session.dispatch({ type: 'apply', input: 2 }); assert(result.ok); assert.equal(result.value.state.data, 3);
  const starts = events.filter(event => event.kind === 'span-started');
  assert(starts.some(event => event.step === 'start')); assert(starts.some(event => event.step === 'direction')); assert(starts.some(event => event.step === 'positive'));
  assert(!starts.some(event => event.step === 'negative')); assert(events.every(event => event.executionId === 'grouped/1'));
  const report = await commands.apply.runDetailed(-1, { input: (_value, name) => name, result: value => value.ok });
  assert.deepEqual(report.trace.map(row => row.step), ['branch.apply:load', 'start', 'direction:no', 'negative']);
  assert.deepEqual(report.observations.map(row => row.step), ['branch.apply:load', 'start', 'negative']);
  assert.equal(report.plan, null);
});

test('Workflow stage references and structure are captured before public method replacement', async () => {
  const flow = workflow('original', (value: number) => ok(value + 1));
  const app = business({ name: 'snapshot', load: async (value: number) => ok(value), save: async (value: number) => ok(value), operations: { apply: [flow] } });
  Reflect.set(flow, 'run', () => ok(999)); Reflect.set(flow, 'inspect', () => ({ result: ok(999), trace: [] }));
  Reflect.set(flow, 'name', 'replaced');
  assert.deepEqual(await app.apply(1), ok(2));
  const report = await app.apply.runDetailed(1, { input: (_value, name) => name, result: value => value.ok });
  assert.deepEqual(report.result, ok(2)); assert.deepEqual(report.trace.map(row => row.step), ['snapshot.apply:load', 'original', 'snapshot.apply']);
  assert.deepEqual(describeFlow(app.apply).nodes.map(node => node.name), report.trace.map(row => row.step));
});

test('nested defects retain their cause and stop both inner and outer subsequent rules', async () => {
  const cause = new Error('nested defect'); let later = 0, saves = 0;
  const broken = workflow('broken', (_value: number): Result<number, never> => { throw cause; })
    .then('inner-later', value => { later++; return ok(value); });
  const app = business({ name: 'defect', load: async (value: number) => ok(value), save: async (value: number) => { saves++; return ok(value); },
    operations: { apply: [broken, (value: number) => { later++; return ok(value); }] },
  });
  await assert.rejects(app.apply.runDetailed(1, { input: () => null, result: result => result.ok }), value => value === cause);
  assert.equal(later, 0); assert.equal(saves, 0);
});

test('explicit Workflows retain replay without re-executing the inner decision', async () => {
  let stored: number | null = null, decisions = 0, saves = 0;
  const flow = workflow('increment', (value: number) => { decisions++; return ok(value + 1); });
  const app = business({ name: 'replay-flow', load: async (value: number) => ok(value), operations: { apply: [flow] },
    save: async (value: number): Promise<Result<Execution<number>, 'Conflict'>> => { saves++; stored = value; return ok({ kind: 'committed', value }); },
    replay: { lookup: (): Result<Receipt<number>, 'Unavailable'> => ok(stored === null ? { kind: 'missing' } : { kind: 'found', value: stored }), resolveAfter: [] },
  });
  assert.deepEqual(await app.apply(1), ok({ kind: 'committed', value: 2 }));
  assert.deepEqual(await app.apply(1), ok({ kind: 'replayed', value: 2 })); assert.equal(decisions, 1); assert.equal(saves, 1);
});

test('unrecognized workflow-shaped objects and ambiguous Workflow Steps are rejected before IO', () => {
  let effects = 0;
  const hybrid = workflow('ambiguous', (value: number) => ok(value)); Object.assign(hybrid, { rule: (value: number) => ok(value + 1) });
  const original = workflow('safe', (value: number) => ok(value + 1));
  const wrong = (_value: number): Result<string, never> => ok('wrong');
  Object.defineProperty(wrong, 'name', { value: 'wrong', writable: true });
  const callable: typeof original = Object.assign(wrong, original);
  for (const [stage, pattern] of [[callable, /AmbiguousBusinessStage/], [{ name: 'fake', run: (value: number) => ok(value), inspect: () => null, steps: [] }, /BusinessRequiresRule/], [hybrid, /AmbiguousBusinessStage/]] as const) {
    assert.throws(() => Reflect.apply(business, undefined, [{ name: 'invalid', load: async (value: number) => { effects++; return ok(value); }, save: async (value: number) => { effects++; return ok(value); }, operations: { apply: [stage] } }]), pattern);
  }
  assert.equal(effects, 0);
});

declare const permit: unique symbol;
type Permitted = Context & { readonly [permit]: true };
declare const check: (value: Context) => Result<Permitted, 'Denied'>;
function typeContracts() {
  const protectedFlow = workflow('approve', (value: Permitted) => ok(value.currency()));
  const load = async (value: number) => ok(new Context(value)), save = async (value: string) => ok(value);
  business({ name: 'valid', load, save, operations: { approve: [check, protectedFlow] } });
  business({ name: 'missing', load, save, operations: {
    // @ts-expect-error a Workflow cannot create the permission proof its input requires
    approve: [protectedFlow],
  } });
  business({ name: 'wrong-save', load: async (value: number) => ok(value), save, operations: {
    // @ts-expect-error a Workflow output must match the save boundary
    apply: [workflow('number', (value: number) => ok(value + 1))],
  } });
  const candidate = true as boolean ? protectedFlow : quoted;
  business({ name: 'dynamic', load, save, operations: {
    // @ts-expect-error every possible Workflow must accept the prior output
    approve: [candidate],
  } });
}
void typeContracts;
