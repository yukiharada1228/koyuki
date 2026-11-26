import test from 'node:test';
import assert from 'node:assert/strict';
import { withInput, ok, err, workflow, business, step, defineTransition, transition, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;

const zero = err({ kind: 'Zero' as const, supplied: 0 });
const unavailable = err({ kind: 'Unavailable' as const, retryAfter: 30 });
const validate = (value: number) => value === 0 ? zero : value < 0 ? err({ kind: 'Negative' as const, min: 0 }) : ok(value * 2);
const refuse = (_value: number) => unavailable;
function select(available: boolean) { return withInput(available ? validate : refuse); }
type ExpectedErrors = { kind: 'Zero'; supplied: number } | { kind: 'Negative'; min: number } | { kind: 'Unavailable'; retryAfter: number };
type Selection = ReturnType<typeof select>;
type SelectionErrors = Assert<Equal<Failure<ReturnType<Selection>>, ExpectedErrors>>;
type SelectionInput = Assert<Equal<Parameters<Selection>[0], number>>;

test('a selected requirement keeps every error and the original failure without a dispatch wrapper', () => {
  assert.strictEqual(select(false)(2), unavailable);
  assert.strictEqual(select(true)(0), zero);
  assert.deepEqual(select(true)(2), ok({ input: 2, value: 4 }));
  const failure = select(true)(-1);
  assert(!failure.ok);
  if (failure.error.kind === 'Negative') { const min: number = failure.error.min; assert.equal(min, 0); }
  if (false) {
    // @ts-expect-error A selected number requirement still requires a number.
    select(true)('wrong');
  }
});

test('selected requirements connect to workflow, transition and business without Result plumbing', async () => {
  for (const available of [true, false]) {
    const requirement = select(available);
    const finish = (pair: Readonly<{ input: number; value: number }>) => ok(pair.input + pair.value);
    const flow = workflow('selected', requirement).then('finish', finish);
    const evolved = transition(defineTransition({ validate: (value: number) => ok(value), require: [step('selected', requirement)], evolve: pair => ok(pair.input + pair.value) }));
    let saves = 0;
    const app = business({ name: 'selected-requirements', load: async (value: number) => ok(value), save: async (value: number) => { saves++; return ok(value); }, operations: { calculate: [requirement, finish] } });
    type FlowError = Assert<Equal<Failure<ReturnType<typeof flow.run>>, ExpectedErrors>>;
    type TransitionError = Assert<Equal<Failure<ReturnType<typeof evolved.run>>, ExpectedErrors>>;
    type BusinessError = Assert<Equal<Failure<Awaited<ReturnType<typeof app.calculate>>>, ExpectedErrors>>;
    assert.deepEqual(flow.run(2), available ? ok(6) : unavailable);
    assert.deepEqual(evolved.run(2), available ? ok(6) : unavailable);
    assert.deepEqual(await app.calculate(2), available ? ok(6) : unavailable);
    assert.equal(saves, available ? 1 : 0);
  }
});

const byAmount = (input: { amount: number }) => input.amount > 0 ? ok({ kind: 'Amount' as const, amount: input.amount }) : err({ kind: 'InvalidAmount' as const });
const byActor = (input: { actor: string }) => input.actor ? ok({ kind: 'Actor' as const, actor: input.actor }) : err({ kind: 'MissingActor' as const });
function intersected(useAmount: boolean) { return withInput(useAmount ? byAmount : byActor); }
type Both = { amount: number } & { actor: string };
type BothInput = Assert<Equal<Parameters<ReturnType<typeof intersected>>[0], Both>>;
type BothResult = Assert<Equal<ReturnType<ReturnType<typeof intersected>>, Result<Readonly<{ input: Both; value: { kind: 'Amount'; amount: number } | { kind: 'Actor'; actor: string } }>, { kind: 'InvalidAmount' } | { kind: 'MissingActor' }>>>;

test('different requirement inputs need an input accepted by every possible selection', () => {
  const input = { amount: 3, actor: 'buyer' };
  const amount = intersected(true)(input), actor = intersected(false)(input);
  assert(amount.ok && actor.ok);
  assert.strictEqual(amount.value.input, input); assert.strictEqual(actor.value.input, input);
  assert.deepEqual(amount.value.value, { kind: 'Amount', amount: 3 });
  assert.deepEqual(actor.value.value, { kind: 'Actor', actor: 'buyer' });
  assert(Object.isFrozen(amount.value)); assert(!Object.isFrozen(input));
  if (false) {
    // @ts-expect-error The actor alternative cannot consume an amount-only input.
    intersected(true)({ amount: 3 });
    // @ts-expect-error The amount alternative cannot consume an actor-only input.
    intersected(false)({ actor: 'buyer' });
  }
});

function invalidSelections(choice: boolean) {
  const stringRule = (value: string) => err({ kind: 'StringRefused' as const, value });
  const incompatible = withInput(choice ? validate : stringRule);
  type NoCommonInput = Assert<Equal<Parameters<typeof incompatible>[0], never>>;
  // @ts-expect-error Selecting a number or string function does not permit calling either input alone.
  incompatible(1);
  // @ts-expect-error Selecting a number or string function does not permit calling either input alone.
  incompatible('one');
  // @ts-expect-error The transition cannot supply a number to every possible requirement.
  defineTransition({ validate: (value: number) => ok(value), require: [step('incompatible', incompatible)], evolve: (value: never) => ok(value) });
  // @ts-expect-error An async alternative requires an effect boundary.
  withInput(choice ? validate : async (value: number) => ok(value));
  // @ts-expect-error Every alternative must return a Result.
  withInput(choice ? validate : (value: number) => value);
  // @ts-expect-error The runtime supplies one argument, so a second required argument is invalid.
  withInput(choice ? validate : (value: number, factor: number) => ok(value * factor));
}
void invalidSelections;

test('generic requirements still preserve nested opaque values through the original signature', () => {
  class Input { #proof = 1; proof() { return this.#proof; } }
  const wrap = <T>(value: T): Result<{ item: { value: T } }, 'Refused'> => ok({ item: { value } });
  const carry = withInput(wrap);
  function forward<T>(input: T) { return carry(input); }
  const input = new Input(), result = forward(input); assert(result.ok);
  type Generic = Assert<Equal<typeof result.value, Readonly<{ input: Input; value: { item: { value: Input } } }>>>;
  assert.strictEqual(result.value.value.item.value, input);
  assert.equal(result.value.value.item.value.proof(), 1);
});

const numberOrString = (value: number | string) => ok({ kind: 'Text' as const, text: String(value) });
const numberOrBoolean = (value: number | boolean) => err({ kind: 'Refused' as const, value });
function overlapping(choice: boolean) { return withInput(choice ? numberOrString : numberOrBoolean); }
type OverlapInput = Assert<Equal<Parameters<ReturnType<typeof overlapping>>[0], number>>;

test('overlap is computed between whole parameter types, not by intersecting every union member', () => {
  assert.deepEqual(overlapping(true)(3), ok({ input: 3, value: { kind: 'Text', text: '3' } }));
  assert.deepEqual(overlapping(false)(3), err({ kind: 'Refused', value: 3 }));
  if (false) {
    // @ts-expect-error Only one of the possible functions accepts a string.
    overlapping(true)('three');
    // @ts-expect-error Only one of the possible functions accepts a boolean.
    overlapping(false)(true);
  }
});
