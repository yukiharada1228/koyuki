import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTransition, defineUseCase, collectEach, withInput, transition, step, ok, err, type Result } from './framework/index.js';
import { validateLine, priceLines, type Line, type LineError, type Quote } from './examples/order-lines.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const quote = (amount: number): Result<number, 'Declined'> => amount > 0 ? ok(amount * 2) : err('Declined');

test('an inline validation combinator preserves the original input when connected to a typed evolution', () => {
  const finish = (pair: Readonly<{ input: number; value: number }>) => {
    const amount: number = pair.input, price: number = pair.value;
    if (false) {
      // @ts-expect-error inference must not turn the preserved input into any
      pair.input.missing;
    }
    return ok(amount + price);
  };
  const flow = transition(defineTransition({ validate: withInput(quote), evolve: finish }));
  type ExactInput = Assert<Equal<Parameters<typeof flow.run>[0], number>>;
  type Exact = Assert<Equal<ReturnType<typeof flow.run>, Result<number, 'Declined'>>>;
  assert.deepEqual(flow.run(2), ok(6)); assert.deepEqual(flow.run(0), err('Declined'));
});

test('inline collection validation remains typed when nested inside a complete use case', async () => {
  let writes = 0;
  const command = defineUseCase({ operation: 'lines.inline', load: async (input: readonly Line[]) => ok(input),
    transition: defineTransition({ validate: collectEach(validateLine), evolve: priceLines }),
    save: async (result: Quote): Promise<Result<number, 'StorageUnavailable'>> => { writes++; return ok(result.totalYen); },
  });
  type ExactInput = Assert<Equal<Parameters<typeof command.run>[0], readonly Line[]>>;
  type ExactResult = Assert<Equal<Awaited<ReturnType<typeof command.run>>, Result<number, readonly { readonly index: number; readonly error: LineError }[] | { kind: 'EmptyOrder' } | { kind: 'OrderTotalOverflow' } | 'StorageUnavailable'>>>;
  assert.deepEqual(await command.run([{ sku: 'x', quantity: 2, unitPriceYen: 3 }]), ok(6));
  assert.deepEqual(await command.run([{ sku: '', quantity: 2, unitPriceYen: 3 }]), err([{ index: 0, error: { kind: 'InvalidSku' } }]));
  assert.equal(writes, 1);
});

function invalidDefinitions() {
  // @ts-expect-error object constraint still requires an actual synchronous Result rule or Step
  defineTransition({ validate: {}, evolve: (_n: number) => ok(1) });
  // @ts-expect-error arbitrary functions cannot masquerade as Result rules
  defineTransition({ validate: (n: number) => n, evolve: (_n: number) => ok(1) });
  // @ts-expect-error nested async validation remains an IO boundary
  defineTransition({ validate: async (n: number) => ok(n), evolve: (_n: number) => ok(1) });
  // @ts-expect-error named validation cannot contain a non-Result rule
  defineTransition({ validate: { name: 'bad', rule: (n: number) => n }, evolve: (_n: number) => ok(1) });
  // @ts-expect-error validation's actual output cannot be erased to fit evolution
  defineTransition({ validate: collectEach(validateLine), evolve: (n: number) => ok(n) });
  const input = defineTransition({ validate: step('quote', withInput(quote)), evolve: pair => ok(pair.value) });
  const exact: Result<number, 'Declined'> = transition(input).run(2); void exact;
}
void invalidDefinitions;
