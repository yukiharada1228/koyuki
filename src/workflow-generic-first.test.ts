import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, withInput, business, ok, err, type Result, type Rule, type Workflow } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
function quote<T extends Base>(value: T): Result<number, 'Declined'> { return value.amount > 0 ? ok(value.amount * 2) : err('Declined'); }
const quoted = withInput(quote);
const direct = workflow('direct', quote);
const bound = workflow('bound', quoted);
const inline = workflow('inline', withInput(quote));
type Input = Assert<Equal<Parameters<typeof direct.run>[0], Base>>;
type Direct = Assert<Equal<ReturnType<typeof direct.run>, Result<number, 'Declined'>>>;
type BoundInput = Assert<Equal<Parameters<typeof bound.run>[0], Base>>;
type Bound = Assert<Equal<ReturnType<typeof bound.run>, Result<Readonly<{ input: Base; value: number }>, 'Declined'>>>;
type Inline = Assert<Equal<ReturnType<typeof inline.run>, ReturnType<typeof bound.run>>>;
type FactoryInput = Assert<Equal<Parameters<typeof workflow>, [name: string, rule: Rule<unknown, unknown, unknown>]>>;
type FactoryOutput = Assert<Equal<ReturnType<typeof workflow>, Workflow<unknown, unknown, unknown>>>;
declare const positive: unique symbol;
type Positive = Base & Readonly<{ [positive]: true }>;
function validatePositive<T extends Base>(value: T): Result<T & Readonly<{ [positive]: true }>, 'InvalidAmount'> {
  return value.amount > 0 ? ok(value as T & Readonly<{ [positive]: true }>) : err('InvalidAmount');
}

test('a generic first Workflow uses its declared input constraint and exact error type', () => {
  assert.deepEqual(direct.inspect({ amount: 2 }), { result: ok(4), trace: [{ step: 'direct', status: 'ok' }] });
  assert.deepEqual(direct.run({ amount: -1 }), err('Declined'));
});

for (const [name, flow] of [['bound', bound], ['inline', inline]] as const) test(`generic withInput can start a Workflow without a context annotation: ${name}`, () => {
  const input = { amount: 2, extra: 'retained at runtime' }, result = flow.run(input); assert(result.ok);
  assert.strictEqual(result.value.input, input); assert.equal(result.value.value, 4); assert(Object.isFrozen(result.value));
  assert.deepEqual(flow.run({ amount: 0 }), err('Declined'));
});

test('a constrained generic first Workflow composes with then and business without repeated input annotations', async () => {
  let saves = 0;
  const calculated = workflow('quote', withInput(quote)).then('total', pair => ok(pair.input.amount + pair.value));
  const app = business({ name: 'generic-first', load: async (input: Base) => ok(input), operations: { calculate: [calculated] },
    save: async (value: number): Promise<Result<number, 'Conflict'>> => { saves++; return ok(value); },
  });
  type Input = Assert<Equal<Parameters<typeof app.calculate>[0], Base>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.calculate>>, Result<number, 'Declined' | 'Conflict'>>>;
  assert.deepEqual(await app.calculate({ amount: 2 }), ok(6));
  const failed = await app.calculate.runDetailed({ amount: -1 });
  assert.deepEqual(failed.result, err('Declined')); assert.equal(failed.plan, null); assert.equal(saves, 1);
  assert.deepEqual(failed.trace.map(row => row.step), ['generic-first.calculate:load', 'quote']);
});

test('compatible function candidates retain every success and error variant', () => {
  const number = (value: Base): Result<number, 'NumberFailure'> => value.amount > 0 ? ok(value.amount) : err('NumberFailure');
  const string = (value: Base): Result<string, 'StringFailure'> => value.amount > 0 ? ok(`${value.amount}`) : err('StringFailure');
  for (const flag of [true, false]) {
    const selected = flag ? number : string, flow = workflow('selected', selected);
    type Input = Assert<Equal<Parameters<typeof flow.run>[0], Base>>;
    type Output = Assert<Equal<ReturnType<typeof flow.run>, Result<number | string, 'NumberFailure' | 'StringFailure'>>>;
    assert.deepEqual(flow.run({ amount: 2 }), flag ? ok(2) : ok('2'));
    assert.deepEqual(flow.run({ amount: 0 }), flag ? err('NumberFailure') : err('StringFailure'));
  }
});

test('a generic first check retains its private output proof for the next domain rule', () => {
  const checked = workflow('positive', validatePositive);
  type Input = Assert<Equal<Parameters<typeof checked.run>[0], Base>>;
  type Output = Assert<Equal<ReturnType<typeof checked.run>, Result<Positive, 'InvalidAmount'>>>;
  const input = { amount: 2, extra: 'original' }, result = checked.run(input); assert(result.ok); assert.strictEqual(result.value, input);
  const complete = checked.then('complete', (value: Positive) => ok(value.amount * 2));
  assert.deepEqual(complete.run(input), ok(4));
  assert.deepEqual(complete.inspect({ amount: 0 }), { result: err('InvalidAmount'), trace: [{ step: 'positive', status: 'error' }] });
});

declare const permitted: unique symbol;
type Permitted = Base & Readonly<{ [permitted]: true }>;
declare const approve: <T extends Permitted>(value: T) => Result<string, 'Closed'>;
declare const incompatible: ((value: { a: string }) => Result<number, 'A'>) | ((value: { b: number }) => Result<string, 'B'>);
function typeContracts() {
  const protectedFlow = workflow('approve', approve);
  type Protected = Assert<Equal<Parameters<typeof protectedFlow.run>[0], Permitted>>;
  // @ts-expect-error the generic constraint still requires the private permission proof
  protectedFlow.run({ amount: 1 });
  // @ts-expect-error a positive amount proof cannot provide a permission proof
  workflow('positive', validatePositive).then('approve', approve);
  business({ name: 'missing-proof', load: async (value: Base) => ok(value), save: async (value: string) => ok(value), operations: {
    // @ts-expect-error a raw load cannot connect to a permission-requiring Workflow
    approve: [protectedFlow],
  } });
  // @ts-expect-error every possible function must accept the inferred input
  workflow('incompatible', incompatible);
  // @ts-expect-error asynchronous work requires an effect boundary
  workflow('async', async (value: Base) => ok(value.amount));
  // @ts-expect-error a plain scalar is not a Result
  workflow('scalar', (value: Base) => value.amount);
  bound.then('extra', pair => {
    // @ts-expect-error the constraint does not promise additional context fields
    pair.input.currency;
    return ok(pair.value);
  });
  // @ts-expect-error the required input field remains a number
  direct.run({ amount: '2' });
}
void typeContracts;
