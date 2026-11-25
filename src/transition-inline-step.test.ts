import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTransition, step, withInput, transition, ok, err, type Result } from './framework/index.js';
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
