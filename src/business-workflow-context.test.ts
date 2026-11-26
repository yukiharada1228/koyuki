import test from 'node:test';
import assert from 'node:assert/strict';
import { business, workflow, withInput, ok, err, type Result, type Rule } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
class Context { #host = 'trusted'; constructor(readonly amount: number, readonly currency: string) {} host() { return this.#host; } }
function currency(value: Context): Result<Context, 'UnsupportedCurrency'> { return value.currency === 'JPY' ? ok(value) : err('UnsupportedCurrency'); }
function quote<T extends Base>(value: T): Result<number, 'Declined'> { return value.amount > 0 ? ok(value.amount * 2) : err('Declined'); }
const quoted = withInput(quote);
// Consumers can express the same input-retention contract through the public
// Rule alias as well as a literal callable. This must retain private class facts.
type Value<R> = R extends { ok: true; value: infer O } ? O : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type PairCandidate<O, I> = { [K in keyof O]: K extends 'input' ? I : O[K] };
type Retained<F extends (...args: never[]) => unknown, I> = F extends Rule<I, PairCandidate<Value<ReturnType<F>>, I>, Failure<ReturnType<F>>>
  ? PairCandidate<Value<ReturnType<F>>, I> : Value<ReturnType<F>>;
type AliasRetainsContext = Assert<Equal<Retained<typeof quoted, Context>, Readonly<{ input: Context; value: number }>>>;
const boundPair = workflow('currency', currency).then('quote', quoted);
const inlinePair = workflow('currency', currency).then('quote', withInput(quote));
const callbackPair = workflow('currency', currency).then('quote', withInput(value => quote(value)));
type PairOutput = Result<Readonly<{ input: Context; value: number }>, 'UnsupportedCurrency' | 'Declined'>;
type BoundPair = Assert<Equal<ReturnType<typeof boundPair.run>, PairOutput>>;
type InlinePair = Assert<Equal<ReturnType<typeof inlinePair.run>, PairOutput>>;
type CallbackPair = Assert<Equal<ReturnType<typeof callbackPair.run>, PairOutput>>;
const bound = boundPair.then('finish', pair => ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`));
const inline = inlinePair.then('finish', pair => ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`));
const callback = callbackPair.then('finish', pair => ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`));

function commands() {
  let saves = 0;
  const app = business({ name: 'context', load: async (input: { amount: number; currency: string }) => ok(new Context(input.amount, input.currency)),
    save: async (value: string): Promise<Result<string, 'Conflict'>> => { saves++; return ok(value); },
    operations: { bound: [bound], inline: [inline], callback: [callback] },
  });
  type Input = Assert<Equal<Parameters<typeof app.bound>[0], { amount: number; currency: string }>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.bound>>, Result<string, 'UnsupportedCurrency' | 'Declined' | 'Conflict'>>>;
  type SameInline = Assert<Equal<Awaited<ReturnType<typeof app.inline>>, Awaited<ReturnType<typeof app.bound>>>>;
  type SameCallback = Assert<Equal<Awaited<ReturnType<typeof app.callback>>, Awaited<ReturnType<typeof app.bound>>>>;
  return { app, saves: () => saves };
}

for (const name of ['bound', 'inline', 'callback'] as const) test(`concrete Workflow context preserves generic withInput without callback annotations: ${name}`, async () => {
  const { app, saves } = commands(), command = app[name];
  const success = await command.runDetailed({ amount: 2, currency: 'JPY' }); assert.deepEqual(success.result, ok('JPY:trusted:4'));
  assert.deepEqual(success.trace.map(row => row.step), [`context.${name}:load`, 'currency', 'quote', 'finish', `context.${name}`]);
  const invalid = await command.runDetailed({ amount: -1, currency: 'USD' });
  assert.deepEqual(invalid.result, err('UnsupportedCurrency')); assert.equal(invalid.trace.length, 2); assert.equal(invalid.plan, null);
  const declined = await command.runDetailed({ amount: -1, currency: 'JPY' });
  assert.deepEqual(declined.result, err('Declined')); assert.equal(declined.trace.length, 3); assert.equal(declined.plan, null); assert.equal(saves(), 1);
});

function typeContracts() {
  // The preceding concrete context does not authorize discarding it, nor supply
  // additional authorization that the actual functions do not promise.
  const broad = (_value: Context): Result<Readonly<{ input: Base; value: number }>, 'Declined'> => ok({ input: { amount: 1 }, value: 2 });
  type BroadStaysBroad = Assert<Equal<Retained<typeof broad, Context>, Readonly<{ input: Base; value: number }>>>;
  workflow('currency', currency).then('broad', broad).then('finish', pair => {
    // @ts-expect-error a monomorphic broad return does not retain the host context
    pair.input.host();
    return ok(pair.value);
  });
  const { app } = commands();
  // @ts-expect-error the request still requires currency
  app.bound({ amount: 1 });
}
void typeContracts;
