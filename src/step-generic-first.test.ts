import test from 'node:test';
import assert from 'node:assert/strict';
import { step, transition, defineTransition, withInput, business, ok, err, type Result, type Rule, type Step } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
function quote<T extends Base>(value: T): Result<number, 'Declined'> { return value.amount > 0 ? ok(value.amount * 2) : err('Declined'); }
const quoted = withInput(quote);
const direct = step('quote', quote), bound = step('bound', quoted), inline = step('inline', withInput(quote));
type Input = Assert<Equal<Parameters<typeof direct.rule>[0], Base>>;
type Output = Assert<Equal<ReturnType<typeof direct.rule>, Result<number, 'Declined'>>>;
type BoundInput = Assert<Equal<Parameters<typeof bound.rule>[0], Base>>;
type BoundOutput = Assert<Equal<ReturnType<typeof bound.rule>, Result<Readonly<{ input: Base; value: number }>, 'Declined'>>>;
type InlineOutput = Assert<Equal<ReturnType<typeof inline.rule>, ReturnType<typeof bound.rule>>>;
type RetainedDirect = Assert<Equal<typeof direct.rule, typeof quote>>;
type RetainedPair = Assert<Equal<typeof bound.rule, typeof quoted>>;
type FactoryInput = Assert<Equal<Parameters<typeof step>, [name: string, rule: Rule<unknown, unknown, unknown>]>>;
type FactoryOutput = Assert<Equal<ReturnType<typeof step>, Step<unknown, unknown, unknown>>>;
declare const positive: unique symbol;
type Positive = Base & Readonly<{ [positive]: true }>;
function validatePositive<T extends Base>(value: T): Result<T & Readonly<{ [positive]: true }>, 'InvalidAmount'> {
  return value.amount > 0 ? ok(value as T & Readonly<{ [positive]: true }>) : err('InvalidAmount');
}

test('a named generic rule uses its declared constraint without a wrapper annotation', () => {
  assert.strictEqual(direct.rule, quote); assert.equal(direct.name, 'quote');
  assert.deepEqual(direct.rule({ amount: 2 }), ok(4));
  assert.deepEqual(direct.rule({ amount: 0 }), err('Declined'));
});

test('a named generic rule retains non-identity output relationships across calls', () => {
  function wrap<T>(input: T) { return ok({ item: input }); }
  const named = step('wrap', wrap), number = named.rule(2), text = named.rule('approved');
  type ActualRule = Assert<Equal<typeof named.rule, typeof wrap>>;
  type NumberResult = Assert<Equal<typeof number, Result<{ item: number }, never>>>;
  type TextResult = Assert<Equal<typeof text, Result<{ item: string }, never>>>;
  assert.strictEqual(named.rule, wrap);
  assert.deepEqual(number, ok({ item: 2 })); assert.deepEqual(text, ok({ item: 'approved' }));
});

test('a contextual Step annotation still supplies an unannotated callback input', () => {
  type Context = Base & Readonly<{ currency: string }>;
  const named: Step<Context, number, never> = step('contextual', input => ok(input.amount));
  assert.deepEqual(named.rule({ amount: 3, currency: 'JPY' }), ok(3));
  assert.equal(named.name, 'contextual');
});

for (const [name, named] of [['bound', bound], ['inline', inline]] as const) test(`a named generic input pair retains runtime identity: ${name}`, () => {
  const input = { amount: 2, extra: 'original' }, result = named.rule(input); assert(result.ok);
  assert.strictEqual(result.value.input, input); assert.equal(result.value.value, 4); assert(Object.isFrozen(result.value));
  assert.deepEqual(named.rule({ amount: 0 }), err('Declined'));
});

test('a generic named validation provides its private output proof to transition', () => {
  let evolved = 0;
  const checked = step('positive', validatePositive);
  type CheckedOutput = Assert<Equal<ReturnType<typeof checked.rule>, Result<Positive, 'InvalidAmount'>>>;
  const input = { amount: 3, extra: 'original' }, result = checked.rule(input); assert(result.ok); assert.strictEqual(result.value, input);
  const flow = transition({ validate: checked, require: [] as const,
    evolve: step('complete', (value: Positive) => { evolved++; return ok(value.amount * 2); }),
  });
  type FlowInput = Assert<Equal<Parameters<typeof flow.run>[0], Base>>;
  type FlowOutput = Assert<Equal<ReturnType<typeof flow.run>, Result<number, 'InvalidAmount'>>>;
  assert.deepEqual(flow.inspect(input), { result: ok(6), trace: [{ step: 'positive', status: 'ok' }, { step: 'complete', status: 'ok' }] });
  assert.deepEqual(flow.inspect({ amount: 0 }), { result: err('InvalidAmount'), trace: [{ step: 'positive', status: 'error' }] });
  assert.equal(evolved, 1);
});

test('a named generic requirement composes with inferred evolve and business without saving failures', async () => {
  const flow = transition(defineTransition({ validate: (value: Base) => ok(value),
    require: [step('quote', withInput(quote))], evolve: pair => ok(pair.input.amount + pair.value),
  }));
  type FlowOutput = Assert<Equal<ReturnType<typeof flow.run>, Result<number, 'Declined'>>>;
  let saves = 0;
  const app = business({ name: 'named-generic', load: async (value: Base) => ok(value),
    save: async (value: number): Promise<Result<number, 'Conflict'>> => { saves++; return ok(value); },
    operations: { calculate: [flow] },
  });
  type AppInput = Assert<Equal<Parameters<typeof app.calculate>[0], Base>>;
  type AppOutput = Assert<Equal<Awaited<ReturnType<typeof app.calculate>>, Result<number, 'Declined' | 'Conflict'>>>;
  assert.deepEqual(await app.calculate({ amount: 2 }), ok(6));
  const failed = await app.calculate.runDetailed({ amount: 0 });
  assert.deepEqual(failed.result, err('Declined')); assert.equal(failed.plan, null); assert.equal(saves, 1);
  assert.deepEqual(failed.trace.map(row => row.step), ['named-generic.calculate:load', 'validate', 'quote']);
});

test('compatible named rule candidates preserve all success and failure variants', () => {
  const number = (value: Base): Result<number, 'NumberFailure'> => value.amount > 0 ? ok(value.amount) : err('NumberFailure');
  const string = (value: Base): Result<string, 'StringFailure'> => value.amount > 0 ? ok(`${value.amount}`) : err('StringFailure');
  for (const flag of [true, false]) {
    const named = step('selected', flag ? number : string);
    type Input = Assert<Equal<Parameters<typeof named.rule>[0], Base>>;
    type Output = Assert<Equal<ReturnType<typeof named.rule>, Result<number | string, 'NumberFailure' | 'StringFailure'>>>;
    assert.deepEqual(named.rule({ amount: 2 }), flag ? ok(2) : ok('2'));
    assert.deepEqual(named.rule({ amount: 0 }), flag ? err('NumberFailure') : err('StringFailure'));
  }
});

declare const permitted: unique symbol;
type Permitted = Base & Readonly<{ [permitted]: true }>;
declare const approve: <T extends Permitted>(value: T) => Result<string, 'Closed'>;
declare const incompatible: ((value: { a: string }) => Result<number, 'A'>) | ((value: { b: number }) => Result<string, 'B'>);
function typeContracts() {
  const protectedStep = step('approve', approve);
  type Protected = Assert<Equal<Parameters<typeof protectedStep.rule>[0], Permitted>>;
  // @ts-expect-error raw input does not have the private permission proof
  protectedStep.rule({ amount: 1 });
  transition({ validate: step('positive', validatePositive), require: [] as const,
    // @ts-expect-error the positive amount proof is not a permission proof
    evolve: protectedStep,
  });
  business({ name: 'missing-proof', load: async (value: Base) => ok(value), save: async (value: string) => ok(value), operations: {
    // @ts-expect-error a raw load cannot connect to a permission-requiring Step
    approve: [protectedStep],
  } });
  // @ts-expect-error every possible rule must accept the inferred input
  step('incompatible', incompatible);
  // @ts-expect-error async functions require an effect boundary
  step('async', async (value: Base) => ok(value.amount));
  // @ts-expect-error a scalar return is not a Result
  step('scalar', (value: Base) => value.amount);
  const paired = bound.rule({ amount: 2 });
  if (paired.ok) {
    // @ts-expect-error a generic constraint does not promise additional context fields
    paired.value.input.currency;
  }
  // @ts-expect-error input remains numeric
  direct.rule({ amount: '2' });
}
void typeContracts;
