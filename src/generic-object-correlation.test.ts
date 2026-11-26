import test from 'node:test';
import assert from 'node:assert/strict';
import { business, defineTransition, transition, step, withInput, ok, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Choice<T> = Readonly<{ kind: 'left'; item: Readonly<{ payload: T }> }> | Readonly<{ kind: 'right'; count: number }>;
const wrap = <T>(input: T): Result<Readonly<{ choice: Choice<T> }>, never> => ok({ choice: { kind: 'left', item: { payload: input } } });

test('a nested union container cannot be treated as the original generic input', () => {
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('wrap', withInput(wrap))], evolve: pair => ok(pair.value) })).run(input);
  }
  const input = { id: 'input-only', amount: 3 }, result = forward(input); assert(result.ok);
  type Shape = Assert<Equal<typeof result.value, Readonly<{ choice: Choice<unknown> }>>>;
  const value = result.value;
  if (false) {
    // @ts-expect-error The producer returns a container, not an input carrying id.
    const id: string = value.choice.id;
    void id;
  }
  assert.equal(result.value.choice.kind, 'left');
  if (result.value.choice.kind === 'left') assert.strictEqual(result.value.choice.item.payload, input);
  assert.equal('id' in result.value.choice, false);
});

test('ordinary generic record fields cannot turn a nested container into the input', () => {
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('wrap', wrap)], evolve: value => ok(value) })).run(input);
  }
  const input = { id: 'input-only' }, result = forward(input); assert(result.ok);
  type Shape = Assert<Equal<typeof result.value, Readonly<{ choice: Choice<unknown> }>>>;
  const value = result.value;
  if (false) {
    // @ts-expect-error An ordinary record container is not the original input either.
    const id: string = value.choice.id;
    void id;
  }
  assert.equal('id' in value.choice, false);
});

test('direct business arrays preserve the container shape without promising input properties', async () => {
  function application<T>(initial: T) {
    return business({ name: 'container', load: async (_id: string) => ok(initial),
      save: async (value: Readonly<{ choice: Choice<unknown> }>) => ok(value), operations: { create: [wrap] },
    });
  }
  const input = { id: 'input-only' }, result = await application(input).create('id'); assert(result.ok);
  const value = result.value;
  type Shape = Assert<Equal<typeof value, Readonly<{ choice: Choice<unknown> }>>>;
  if (false) {
    // @ts-expect-error Public business results must not invent an input id on the container.
    const id: string = value.choice.id;
    void id;
  }
  if (value.choice.kind === 'left') assert.strictEqual(value.choice.item.payload, input);
});

test('the extra witness retains real input intersections and fixed validation facts', () => {
  type Proof = Readonly<{ checked: true }>;
  const mark = <T>(input: T): Result<Readonly<{ marked: T & Proof }>, never> => ok({ marked: Object.assign({}, input, { checked: true as const }) });
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('mark', withInput(mark))], evolve: pair => {
      type Shape = Assert<Equal<typeof pair.value, Readonly<{ marked: T & Proof }>>>;
      return ok(pair.value.marked);
    } })).run(input);
  }
  const input = { id: 'input' }, result = forward(input); assert(result.ok);
  assert.deepEqual(result.value, { id: 'input', checked: true });
});
