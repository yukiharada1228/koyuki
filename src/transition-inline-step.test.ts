import test from 'node:test';
import assert from 'node:assert/strict';
import { business, defineTransition, step, withInput, transition, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

test('a named inline requirement keeps the unannotated evolve context and stops on failure', () => {
  const calls: string[] = [];
  const quote = (amount: number): Result<number, 'Declined'> => {
    calls.push('quote'); return amount > 0 ? ok(amount * 2) : err('Declined');
  };
  const flow = transition(defineTransition({
    validate: (amount: number) => { calls.push('validate'); return ok(amount); },
    require: [step('quote', withInput(quote))],
    evolve: pair => {
      type Context = Assert<Equal<typeof pair, Readonly<{ input: number; value: number }>>>;
      calls.push('evolve'); assert(Object.isFrozen(pair)); return ok(pair.input + pair.value);
    },
  }));
  type Input = Assert<Equal<Parameters<typeof flow.run>[0], number>>;
  type Output = Assert<Equal<ReturnType<typeof flow.run>, Result<number, 'Declined'>>>;
  assert.deepEqual(flow.run(3), ok(9)); assert.deepEqual(calls.splice(0), ['validate', 'quote', 'evolve']);
  const failed = flow.inspect(-1);
  assert.deepEqual(failed.result, err('Declined')); assert.deepEqual(calls, ['validate', 'quote']);
  assert.deepEqual(failed.trace, [{ step: 'validate', status: 'ok' }, { step: 'quote', status: 'error' }]);
});

test('a scoped generic caller keeps extra input fields through a named inline requirement', () => {
  function forward<T extends { amount: number }>(input: T) {
    const flow = transition(defineTransition({
      validate: (value: T): Result<T, never> => ok(value),
      require: [step('wrap', withInput((value: T) => ok({ item: value })))],
      evolve: pair => ok({ before: pair.input, after: pair.value.item }),
    }));
    return flow.run(input);
  }
  const input = { amount: 3, currency: 'JPY' as const }, result = forward(input);
  type Exact = Assert<Equal<typeof result, Result<{ before: typeof input; after: typeof input }, never>>>;
  assert(result.ok); assert.strictEqual(result.value.before, input); assert.strictEqual(result.value.after, input);
});

function invalidConnection() {
  const quote = (amount: number) => ok(amount * 2);
  defineTransition({ validate: (text: string) => ok(text),
    // @ts-expect-error naming an inline requirement does not make number accept a string
    require: [step('quote', withInput(quote))],
    evolve: pair => ok(pair.value),
  });
}
void invalidConnection;

for (const variant of ['inline', 'bound'] as const) test(`a polymorphic input pair reaches unannotated evolve: ${variant}`, async () => {
  const calls: string[] = [];
  function identity<T>(value: T): Result<T, 'Declined'> {
    calls.push('identity'); return typeof value === 'number' && value < 0 ? err('Declined') : ok(value);
  }
  const bound = step('identity', withInput(identity));
  const flow = transition(defineTransition({
    validate: (value: number) => { calls.push('validate'); return ok(value); },
    require: [variant === 'inline' ? step('identity', withInput(identity)) : bound],
    evolve: pair => {
      type Context = Assert<Equal<typeof pair, Readonly<{ input: number; value: number }>>>;
      calls.push('evolve'); assert(Object.isFrozen(pair)); return ok(pair.input + pair.value);
    },
  }));
  type Exact = Assert<Equal<ReturnType<typeof flow.run>, Result<number, 'Declined'>>>;
  let saves = 0;
  const app = business({ name: 'identity', load: async (value: number) => ok(value),
    save: async (value: number) => { saves++; return ok(value); }, operations: { double: [flow] },
  });
  assert.deepEqual(await app.double(3), ok(6)); assert.equal(saves, 1);
  assert.deepEqual(calls.splice(0), ['validate', 'identity', 'evolve']);
  const failed = await app.double.runDetailed(-1);
  assert.deepEqual(failed.result, err('Declined')); assert.equal(saves, 1);
  assert.deepEqual(calls, ['validate', 'identity']);
  assert.deepEqual(failed.trace.map(row => row.step), ['identity.double:load', 'validate', 'identity']);
});

test('multiple generic input pairs retain literal context, intermediate values and closed failures', () => {
  type Context = Readonly<{ amount: number; currency: 'JPY' }>;
  function quote<T extends { amount: number }>(value: T): Result<number, 'Declined'> {
    return value.amount > 0 ? ok(value.amount * 2) : err('Declined');
  }
  function fee<T extends { value: number }>(value: T): Result<number, 'TooLarge'> {
    return value.value <= 10 ? ok(1) : err('TooLarge');
  }
  const flow = transition(defineTransition({ validate: (value: Context) => ok(value),
    require: [step('quote', withInput(quote)), step('fee', withInput(fee))],
    evolve: pair => {
      type Pair = Assert<Equal<typeof pair, Readonly<{ input: Readonly<{ input: Context; value: number }>; value: number }>>>;
      return ok({ currency: pair.input.input.currency, total: pair.input.value + pair.value });
    },
  }));
  type Input = Assert<Equal<Parameters<typeof flow.run>[0], Context>>;
  type Output = Assert<Equal<ReturnType<typeof flow.run>, Result<{ currency: 'JPY'; total: number }, 'Declined' | 'TooLarge'>>>;
  assert.deepEqual(flow.run({ amount: 2, currency: 'JPY' }), ok({ currency: 'JPY', total: 5 }));
  assert.deepEqual(flow.inspect({ amount: 0, currency: 'JPY' }), { result: err('Declined'), trace: [
    { step: 'validate', status: 'ok' }, { step: 'quote', status: 'error' },
  ] });
  assert.deepEqual(flow.inspect({ amount: 6, currency: 'JPY' }), { result: err('TooLarge'), trace: [
    { step: 'validate', status: 'ok' }, { step: 'quote', status: 'ok' }, { step: 'fee', status: 'error' },
  ] });
});

test('specialized pair input retains an opaque class and the original rule remains polymorphic', () => {
  class Context { #currency = 'JPY'; constructor(readonly amount: number) {} currency() { return this.#currency; } }
  const identity = <T>(value: T): Result<T, never> => ok(value), named = step('retain', withInput(identity));
  const definition = defineTransition({ validate: (value: Context) => ok(value), require: [named],
    evolve: pair => {
      type Pair = Assert<Equal<typeof pair, Readonly<{ input: Context; value: Context }>>>;
      assert.strictEqual(pair.input, pair.value); return ok(pair.value.currency());
    },
  });
  const input = new Context(2), pair = definition.require[0].rule(input); assert(pair.ok);
  if (false) {
    // @ts-expect-error normalized requirements promise a result for this declared context only
    definition.require[0].rule('another-context');
  }
  type Pair = Assert<Equal<typeof pair.value, Readonly<{ input: Context; value: Context }>>>;
  assert.strictEqual(pair.value.input, input); assert.strictEqual(pair.value.value, input);
  assert.deepEqual(transition(definition).run(input), ok('JPY'));
  const unrelated = named.rule('still-generic');
  type Unrelated = Assert<Equal<typeof unrelated, Result<Readonly<{ input: string; value: string }>, never>>>;
  assert.deepEqual(unrelated, ok({ input: 'still-generic', value: 'still-generic' }));
});

test('pair specialization preserves additional facts supplied by the producer', () => {
  const proof: unique symbol = Symbol('authorized');
  type Authorized = Readonly<{ amount: number; [proof]: true }>;
  const authorize = (value: { amount: number }): Result<Readonly<{ input: Authorized; value: number }>, 'Denied'> =>
    value.amount > 0 ? ok({ input: { ...value, [proof]: true }, value: value.amount * 2 }) : err('Denied');
  const flow = transition(defineTransition({ validate: (value: { amount: number }) => ok(value),
    require: [step('authorize', authorize)], evolve: pair => {
      type Exact = Assert<Equal<typeof pair.input, Authorized>>;
      const fact: true = pair.input[proof]; assert(fact); return ok(pair.value);
    },
  }));
  assert.deepEqual(flow.run({ amount: 2 }), ok(4)); assert.deepEqual(flow.run({ amount: 0 }), err('Denied'));
});

function unsafeSpecialization() {
  type Base = Readonly<{ amount: number }>;
  type Context = Base & Readonly<{ currency: 'JPY' }>;
  type Pair = Readonly<{ input: Base; value: number }>;
  const broad = (value: Base): Result<Pair, never> => ok({ input: { amount: value.amount }, value: value.amount });
  defineTransition({ validate: (value: Context) => ok(value), require: [step('broad', broad)], evolve: pair => {
    type Original = Assert<Equal<typeof pair.input, Base>>;
    // @ts-expect-error a broad producer may drop currency; the prior input alone cannot restore it
    return ok(pair.input.currency);
  } });
  const generic = withInput(<T extends Base>(value: T) => ok(value.amount));
  const alternative = Math.random() ? generic : broad;
  defineTransition({ validate: (value: Context) => ok(value), require: [step('alternative', alternative)], evolve: pair => {
    // @ts-expect-error every dynamic producer must promise the retained field
    return ok(pair.input.currency);
  } });
  function unknownValue<T>(value: T): Result<Readonly<{ input: T; value: unknown }>, never> {
    return ok({ input: value, value: null });
  }
  defineTransition({ validate: (value: Context) => ok(value), require: [step('unknown-value', unknownValue)], evolve: pair => {
    const currency: 'JPY' = pair.input.currency; void currency;
    // @ts-expect-error retaining input cannot invent a correlation for an unknown success value
    return ok(pair.value.currency);
  } });
  defineTransition({ validate: (value: string) => ok(value),
    // @ts-expect-error retaining a generic pair does not make Base accept a string
    require: [step('wrong-input', generic)], evolve: pair => ok(pair.value),
  });
}
void unsafeSpecialization;

for (const variant of ['inline', 'bound'] as const) test(`a separately generic caller retains both sides of an identity pair: ${variant}`, () => {
  const calls: string[] = [];
  function identity<T>(value: T): Result<T, 'Declined'> {
    calls.push('identity'); return value === 'reject' ? err('Declined') : ok(value);
  }
  const named = step('identity', withInput(identity));
  function forward<T>(input: T) {
    const flow = transition(defineTransition({
      validate: (value: T) => { calls.push('validate'); return ok(value); },
      require: [variant === 'inline' ? step('identity', withInput(identity)) : named],
      evolve: pair => {
        type ExactPair = Assert<Equal<typeof pair, Readonly<{ input: T; value: T }>>>;
        assert(Object.isFrozen(pair)); calls.push('evolve'); return ok({ before: pair.input, after: pair.value });
      },
    }));
    return flow.run(input);
  }
  const input = { id: 'one', currency: 'JPY' as const }, result = forward(input);
  type Exact = Assert<Equal<typeof result, Result<{ before: typeof input; after: typeof input }, 'Declined'>>>;
  assert(result.ok); assert.strictEqual(result.value.before, input); assert.strictEqual(result.value.after, input);
  assert.deepEqual(calls.splice(0), ['validate', 'identity', 'evolve']);
  class Context { #token = 'trusted'; token() { return this.#token; } }
  const opaque = new Context(), preserved = forward(opaque);
  type Opaque = Assert<Equal<typeof preserved, Result<{ before: Context; after: Context }, 'Declined'>>>;
  assert(preserved.ok); assert.strictEqual(preserved.value.after, opaque); assert.equal(preserved.value.before.token(), 'trusted');
  calls.splice(0); assert.deepEqual(forward('reject'), err('Declined'));
  assert.deepEqual(calls, ['validate', 'identity']);
});

test('a separately generic caller retains input without assuming its computed value is an identity', () => {
  function score<T>(value: T): Result<number, 'Declined'> { return value === null ? err('Declined') : ok(7); }
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value),
      require: [step('score', withInput(score))], evolve: pair => {
        type Pair = Assert<Equal<typeof pair, Readonly<{ input: T; value: number }>>>;
        return ok({ original: pair.input, score: pair.value });
      },
    })).run(input);
  }
  const input = { correlationId: 'original' }, result = forward(input);
  type Exact = Assert<Equal<typeof result, Result<{ original: typeof input; score: number }, 'Declined'>>>;
  assert(result.ok); assert.strictEqual(result.value.original, input); assert.equal(result.value.score, 7);
  assert.deepEqual(forward(null), err('Declined'));
});

function unsafeUniversalSpecialization<T>(input: T) {
  const broad = (_value: unknown): Result<Readonly<{ input: unknown; value: unknown }>, never> => ok({ input: null, value: null });
  const finish = (pair: Readonly<{ input: T; value: T }>) => ok(pair);
  // @ts-expect-error accepting any input does not promise to return either member with that input's type
  defineTransition({ validate: (value: T): Result<T, never> => ok(value), require: [step('broad', broad)], evolve: finish });
  const unknownValue = <V>(value: V): Result<Readonly<{ input: V; value: unknown }>, never> => ok({ input: value, value: null });
  defineTransition({ validate: (value: T): Result<T, never> => ok(value), require: [step('unknown', unknownValue)], evolve: pair => {
    const before: T = pair.input;
    type StillUnknown = Assert<Equal<typeof pair.value, unknown>>;
    // @ts-expect-error a universal input promise does not correlate an unknown value with T
    const after: T = pair.value;
    return ok({ before, after });
  } });
  const alternative = Math.random() ? withInput(<V>(value: V) => ok(value)) : broad;
  // @ts-expect-error every producer in the union must promise the correspondence required by finish
  defineTransition({ validate: (value: T): Result<T, never> => ok(value), require: [step('alternative', alternative)], evolve: finish });
  void input;
}
void unsafeUniversalSpecialization;
