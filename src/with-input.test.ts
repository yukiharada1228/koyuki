import test from 'node:test';
import assert from 'node:assert/strict';
import { withInput, defineTransition, transition, ok, err, type Result } from './framework/index.js';
const quote = (input: { readonly amount: number }): Result<number, { kind: 'Declined' }> => input.amount > 0 ? ok(input.amount * 2) : err({ kind: 'Declined' });
test('a successful requirement preserves the exact original input and its value without copying domain objects', () => {
  const input = { amount: 2 }, evaluate = withInput(quote);
  const result = evaluate(input); assert(result.ok);
  assert.equal(result.value.input, input); assert.equal(result.value.value, 4);
  assert(Object.isFrozen(result.value)); assert(!Object.isFrozen(input));
});
test('a failed requirement returns the same failure and prevents evolution', () => {
  let calls = 0;
  const failed = err({ kind: 'Declined' } as const);
  const rule = withInput((_n: number) => failed);
  assert.equal(rule(2), failed);
  const validate = (input: { amount: number }) => ok(input);
  const requirement = withInput(quote);
  const next = transition(defineTransition({ validate, require: [requirement],
    evolve: pair => {
      if (false) {
        // @ts-expect-error the successful value must not widen to any
        pair.value.notAValue;
      }
      calls++; return ok(pair.input.amount + pair.value);
    },
  }));
  const exact: Result<number, { kind: 'Declined' }> = next.run({ amount: -1 }); void exact;
  assert.deepEqual(next.run({ amount: -1 }), err({ kind: 'Declined' })); assert.equal(calls, 0);
  assert.deepEqual(next.run({ amount: 2 }), ok(6)); assert.equal(calls, 1);
});
test('construction performs no work and thrown defects remain visible', () => {
  let calls = 0;
  const rule = withInput((_n: number): Result<number, never> => { calls++; throw new Error('defect'); });
  assert.equal(calls, 0); assert.throws(() => rule(1), /defect/); assert.equal(calls, 1);
});
function typeContracts() {
  const next = withInput(quote);
  const exact: Result<Readonly<{ input: { readonly amount: number }; value: number }>, { kind: 'Declined' }> = next({ amount: 2 }); void exact;
  // @ts-expect-error callers must supply the requirement input
  next({ value: 2 });
  // @ts-expect-error async effects cannot be disguised as pure requirements
  withInput(async (n: number) => ok(n));
}
void typeContracts;
