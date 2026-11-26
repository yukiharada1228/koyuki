import test from 'node:test';
import assert from 'node:assert/strict';
import { business, defineTransition, transition, step, withInput, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Envelope<T> = Readonly<{ current: T; previous: T; kind: 'wrapped'; count: number; maybe?: T }>;

for (const variant of ['inline', 'bound'] as const) test(`generic value fields retain arbitrary names, optionality and fixed metadata: ${variant}`, () => {
  const calls: string[] = [];
  function envelope<T>(input: T): Result<Envelope<T>, 'Refused'> {
    calls.push('envelope'); return input === null ? err('Refused') : ok(Object.freeze({ current: input, previous: input, kind: 'wrapped', count: 7, maybe: input }));
  }
  const named = step('envelope', withInput(envelope));
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value),
      require: [variant === 'inline' ? step('envelope', withInput(envelope)) : named], evolve: pair => {
        type Pair = Assert<Equal<typeof pair, Readonly<{ input: T; value: Envelope<T> }>>>;
        calls.push('evolve'); assert(Object.isFrozen(pair)); return ok(pair.value);
      },
    })).run(input);
  }
  const input = { id: 'request', currency: 'JPY' as const }, result = forward(input);
  type Exact = Assert<Equal<typeof result, Result<Envelope<typeof input>, 'Refused'>>>;
  assert(result.ok); assert.strictEqual(result.value.current, input); assert.strictEqual(result.value.previous, input);
  assert.strictEqual(result.value.maybe, input); assert.equal(result.value.kind, 'wrapped'); assert.equal(result.value.count, 7);
  assert.deepEqual(calls.splice(0), ['envelope', 'evolve']);
  class Context { #token = 'trusted'; token() { return this.#token; } }
  const context = new Context(), opaque = forward(context); assert(opaque.ok);
  type Opaque = Assert<Equal<typeof opaque.value, Envelope<Context>>>;
  assert.strictEqual(opaque.value.current, context); assert.equal(opaque.value.current.token(), 'trusted');
  assert.equal(Object.isFrozen(context), false);
  calls.splice(0); assert.deepEqual(forward(null), err('Refused')); assert.deepEqual(calls, ['envelope']);
});

test('generic readonly tuple elements retain their input and fixed literal element', () => {
  const wrap = <T>(input: T): Result<readonly [T, T, 'fixed'], never> => ok([input, input, 'fixed'] as const);
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('tuple', withInput(wrap))], evolve: pair => {
      type Value = Assert<Equal<typeof pair.value, readonly [T, T, 'fixed']>>;
      return ok(pair.value);
    } })).run(input);
  }
  const input = { amount: 2 }, result = forward(input); assert(result.ok);
  type Value = Assert<Equal<typeof result.value, readonly [typeof input, typeof input, 'fixed']>>;
  assert.strictEqual(result.value[0], input); assert.strictEqual(result.value[1], input); assert.equal(result.value[2], 'fixed');
});

test('generic readonly array elements retain their input type', () => {
  const wrap = <T>(input: T): Result<readonly T[], never> => ok(Object.freeze([input, input]));
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('array', withInput(wrap))], evolve: pair => {
      type Value = Assert<Equal<typeof pair.value, readonly T[]>>;
      return ok(pair.value);
    } })).run(input);
  }
  const input = { amount: 2 }, result = forward(input); assert(result.ok);
  type Value = Assert<Equal<typeof result.value, readonly (typeof input)[]>>;
  assert(Object.isFrozen(result.value)); assert.equal(result.value.length, 2); assert.strictEqual(result.value[0], input);
});

test('a generic readonly index signature retains its value type', () => {
  const wrap = <T>(input: T): Result<Readonly<Record<string, T>>, never> => ok(Object.freeze({ primary: input, secondary: input }));
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('record', withInput(wrap))], evolve: pair => {
      type Value = Assert<Equal<typeof pair.value, Readonly<Record<string, T>>>>;
      return ok(pair.value);
    } })).run(input);
  }
  const input = { amount: 2 }, result = forward(input); assert(result.ok);
  assert(Object.isFrozen(result.value)); assert.strictEqual(result.value.primary, input); assert.strictEqual(result.value.secondary, input);
});

type Choice<T> = Readonly<{ kind: 'left'; left: T }> | Readonly<{ kind: 'right'; right: T }>;
for (const kind of ['left', 'right'] as const) test(`generic field refinement preserves a discriminated union: ${kind}`, () => {
  const wrap = <T>(input: T): Result<Choice<T>, never> => ok(kind === 'left' ? { kind, left: input } : { kind, right: input });
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('choice', withInput(wrap))], evolve: pair => {
      type Value = Assert<Equal<typeof pair.value, Choice<T>>>;
      const value = pair.value.kind === 'left' ? pair.value.left : pair.value.right;
      type Selected = Assert<Equal<typeof value, T>>;
      return ok({ kind: pair.value.kind, value });
    } })).run(input);
  }
  const input = { id: 'original' }, result = forward(input); assert(result.ok);
  type Exact = Assert<Equal<typeof result.value, { kind: 'left' | 'right'; value: typeof input }>>;
  assert.equal(result.value.kind, kind); assert.strictEqual(result.value.value, input);
});

const verified: unique symbol = Symbol('verified');
type Verified<T> = Readonly<{ payload: T; [verified]: true }>;
test('generic value refinement retains a private symbol proof', () => {
  const wrap = <T>(input: T): Result<Verified<T>, never> => ok(Object.freeze({ payload: input, [verified]: true }));
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('verify', withInput(wrap))], evolve: pair => {
      type Value = Assert<Equal<typeof pair.value, Verified<T>>>;
      const proof: true = pair.value[verified]; assert(proof); return ok(pair.value);
    } })).run(input);
  }
  const input = { id: 'original' }, result = forward(input); assert(result.ok);
  assert.strictEqual(result.value.payload, input); assert.equal(result.value[verified], true);
});

test('refined generic values reach business save with exact output and failure types', async () => {
  const saves: unknown[] = [];
  const wrap = <T>(input: T): Result<Readonly<{ subject: T; tag: 'ready' }>, 'Refused'> => input === null ? err('Refused') : ok({ subject: input, tag: 'ready' });
  function application<T>(initial: T) {
    const flow = transition(defineTransition({ validate: (value: T) => ok(value), require: [step('wrap', withInput(wrap))], evolve: pair => ok(pair.value) }));
    return business({ name: 'envelope', load: async (_id: string) => ok(initial),
      save: async (value: Readonly<{ subject: T; tag: 'ready' }>): Promise<Result<typeof value, 'Conflict'>> => { saves.push(value); return ok(value); },
      operations: { create: [flow] },
    });
  }
  const input = { id: 'original' }, app = application(input), result = await app.create('request'); assert(result.ok);
  type Exact = Assert<Equal<typeof result, { ok: true; value: Readonly<{ subject: typeof input; tag: 'ready' }> }>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Readonly<{ subject: typeof input; tag: 'ready' }>, 'Refused' | 'Conflict'>>>;
  assert.strictEqual(result.value.subject, input); assert.equal(saves.length, 1);
  const failed = await application(null).create.runDetailed('refused');
  assert.deepEqual(failed.result, err('Refused')); assert.equal(saves.length, 1);
  assert.deepEqual(failed.trace.map(row => row.step), ['envelope.create:load', 'validate', 'wrap']);
});

for (const variant of ['inline', 'bound'] as const) test(`business connects generic value fields directly without a composition Workflow: ${variant}`, async () => {
  let saves = 0;
  function envelope<T>(input: T): Result<Envelope<T>, 'Refused'> {
    return input === null ? err('Refused') : ok({ current: input, previous: input, kind: 'wrapped', count: 7 });
  }
  const named = step('envelope', withInput(envelope));
  function application<T>(initial: T) {
    const project = ({ value }: Readonly<{ value: Envelope<T> }>) => ok(value);
    return business({ name: 'direct-envelope', load: async (_id: string) => ok(initial),
      save: async (value: Envelope<T>): Promise<Result<Envelope<T>, 'Conflict'>> => { saves++; return ok(value); },
      operations: { create: [variant === 'inline' ? step('envelope', withInput(envelope)) : named, project] },
    });
  }
  class Context { #token = 'private'; token() { return this.#token; } }
  const input = new Context(), app = application(input), result = await app.create('request'); assert(result.ok);
  type Input = Assert<Equal<Parameters<typeof app.create>[0], string>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<Envelope<Context>, 'Refused' | 'Conflict'>>>;
  assert.strictEqual(result.value.current, input); assert.equal(result.value.previous.token(), 'private'); assert.equal(saves, 1);
  const failed = await application(null).create.runDetailed('refused');
  assert.deepEqual(failed.result, err('Refused')); assert.equal(saves, 1);
  assert.deepEqual(failed.trace.map(row => row.step), ['direct-envelope.create:load', 'envelope']);
});

test('sharing pair inference preserves existing non-pair business identity rules', async () => {
  const identity = <T>(input: T) => ok(input), input = { amount: 3, currency: 'JPY' as const };
  const app = business({ name: 'plain-identity', load: async (_id: string) => ok(input),
    save: async (value: typeof input) => ok(value), operations: { keep: [identity] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.keep>>, Result<typeof input, never>>>;
  const result = await app.keep('request'); assert(result.ok); assert.strictEqual(result.value, input);
});

test('a narrower domain method keeps required request fields during loader specialization', async () => {
  type Request = Readonly<{ id: string; token: string }>;
  const load = async <T>(input: T) => ok({ input });
  const rules = { check(value: Readonly<{ input: Request }>) { return ok(value.input.token.length); } };
  const app = business({ name: 'method-request', load, save: async (value: number) => ok(value), operations: { check: [rules.check] } });
  type Input = Assert<Equal<Parameters<typeof app.check>[0], Request>>;
  if (false) {
    // @ts-expect-error method variance cannot remove the operation's required token
    app.check({ id: 'missing-token' });
  }
  assert.deepEqual(await app.check({ id: 'request', token: 'abc' }), ok(3));
});

test('unrelated unknown values and fixed fields remain unchanged', () => {
  const wrap = <T>(input: T): Result<Readonly<{ retained: T; unrelated: unknown; count: number }>, never> => ok({ retained: input, unrelated: null, count: 3 });
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('mixed', withInput(wrap))], evolve: pair => {
      type Value = Assert<Equal<typeof pair.value, Readonly<{ retained: T; unrelated: unknown; count: number }>>>;
      return ok(pair.value);
    } })).run(input);
  }
  const input = { id: 'original' }, result = forward(input); assert(result.ok);
  assert.strictEqual(result.value.retained, input); assert.equal(result.value.unrelated, null); assert.equal(result.value.count, 3);
});

test('value refinement does not erase private class identity', () => {
  class Box<T> { #token = 'private'; constructor(readonly item: T) {} token() { return this.#token; } }
  const wrap = <T>(input: T): Result<Box<T>, never> => ok(new Box(input));
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('box', withInput(wrap))], evolve: pair => {
      type Preserved = Assert<Equal<typeof pair.value, Box<unknown>>>;
      return ok(pair.value);
    } })).run(input);
  }
  const input = { id: 'original' }, result = forward(input); assert(result.ok);
  assert(result.value instanceof Box); assert.strictEqual(result.value.item, input); assert.equal(result.value.token(), 'private');
});

test('a pair-level discriminator keeps its corresponding value variant', () => {
  type Pair<T> = Readonly<{ input: T; kind: 'left'; value: { left: T } }> | Readonly<{ input: T; kind: 'right'; value: { right: T } }>;
  for (const kind of ['left', 'right'] as const) {
    const wrap = <T>(input: T): Result<Pair<T>, never> => ok(kind === 'left' ? { input, kind, value: { left: input } } : { input, kind, value: { right: input } });
    function forward<T>(input: T) {
      return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('pair', wrap)], evolve: pair => {
        if (pair.kind === 'left') {
          // @ts-expect-error the value of a left pair cannot acquire the right branch
          void pair.value.right;
          return ok(pair.value.left);
        }
        // @ts-expect-error the value of a right pair cannot acquire the left branch
        void pair.value.left;
        return ok(pair.value.right);
      } })).run(input);
    }
    const input = { id: 'original' }, result = forward(input); assert(result.ok); assert.strictEqual(result.value, input);
  }
});

type Overlapping = Readonly<{ a: unknown }> | Readonly<{ b: unknown }>;
type InputValue<I, V> = Readonly<{ input: I; value: V }>;
// Both-null values meet each individual overload through a different branch.
// Neither overload promises the combination a:T | b:T.
function overlapping<T>(input: T): Result<InputValue<T, Readonly<{ a: T }> | Readonly<{ b: unknown }>>, never>;
function overlapping<T>(input: T): Result<InputValue<T, Readonly<{ a: unknown }> | Readonly<{ b: T }>>, never>;
function overlapping(input: unknown): Result<InputValue<unknown, Overlapping>, never>;
function overlapping(input: unknown): Result<InputValue<unknown, Overlapping>, never> { return ok({ input, value: { a: null, b: null } }); }

test('individual field promises cannot invent a joint refinement across overlapping union branches', () => {
  const flow = transition(defineTransition({ validate: (value: number) => ok(value), require: [step('overlapping', overlapping)], evolve: pair => {
    type Value = Assert<Equal<typeof pair.value, Overlapping>>;
    return ok(pair.value);
  } }));
  assert.deepEqual(flow.run(3), ok({ a: null, b: null }));
});

function rejectedRefinements<T>(input: T) {
  const unknown = <V>(value: V): Result<Readonly<{ input: V; value: { payload: unknown } }>, never> => ok({ input: value, value: { payload: null } });
  defineTransition({ validate: (value: T) => ok(value), require: [step('unknown', unknown)], evolve: pair => {
    const original: T = pair.input; void original;
    // @ts-expect-error a universal input promise does not make an unrelated child into T
    const payload: T = pair.value.payload;
    return ok(payload);
  } });
  const unknownRecord = <V>(value: V): Result<Readonly<{ input: V; value: Readonly<Record<string, unknown>> }>, never> => ok({ input: value, value: { retained: value, foreign: null } });
  defineTransition({ validate: (value: T) => ok(value), require: [step('unknown-record', unknownRecord)], evolve: pair => {
    type Value = Assert<Equal<typeof pair.value, Readonly<Record<string, unknown>>>>;
    // @ts-expect-error a broad record declaration does not promise that all entries have type T
    const foreign: T = pair.value.foreign;
    return ok(foreign);
  } });
  const raw = <V>(value: V) => ok({ payload: value });
  const finish = (pair: Readonly<{ input: T; value: Verified<T> }>) => ok(pair.value.payload);
  // @ts-expect-error mapping value fields cannot supply an undeclared private proof
  defineTransition({ validate: (value: T) => ok(value), require: [step('raw', withInput(raw))], evolve: finish });
  const broad = (_value: unknown): Result<Readonly<{ input: unknown; value: { payload: unknown } }>, never> => ok({ input: null, value: { payload: null } });
  const alternative = Math.random() ? withInput(raw) : broad;
  const paired = (pair: Readonly<{ input: T; value: { payload: T } }>) => ok(pair.value.payload);
  // @ts-expect-error every dynamic producer must guarantee the child correlation
  defineTransition({ validate: (value: T) => ok(value), require: [step('alternative', alternative)], evolve: paired });
  const jointlyRefined = (pair: InputValue<number, Readonly<{ a: number }> | Readonly<{ b: number }>>) => ok(pair.value);
  // @ts-expect-error the same producer must guarantee all refinements together, not via different union branches
  defineTransition({ validate: (value: number) => ok(value), require: [step('overlapping', overlapping)], evolve: jointlyRefined });
  void input;
}
void rejectedRefinements;

// Ordinary records must retain generic correlation without a withInput wrapper.
for (const named of [false, true]) test(`ordinary generic records retain caller input without a pair wrapper: ${named}`, async () => {
  type RecordOf<T> = Readonly<{ before: T; after: T; maybe?: T; count: number; kind: 'record' }>;
  const wrap = <T>(input: T): Result<RecordOf<T>, 'Refused'> => input === null ? err('Refused') : ok({ before: input, after: input, maybe: input, count: 2, kind: 'record' });
  const stage = named ? step('record', wrap) : wrap;
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [stage], evolve: value => {
      type Exact = Assert<Equal<typeof value, RecordOf<T>>>;
      return ok(value);
    } })).run(input);
  }
  let saves = 0;
  function application<T>(initial: T) {
    const finish = (value: RecordOf<T>) => ok(value);
    return business({ name: 'ordinary-record', load: async (_id: string) => ok(initial),
      save: async (value: RecordOf<T>): Promise<Result<RecordOf<T>, 'Conflict'>> => { saves++; return ok(value); },
      operations: { create: [stage, finish] },
    });
  }
  class Input { #token = 'trusted'; token() { return this.#token; } }
  const input = new Input(), result = forward(input); assert(result.ok);
  type Exact = Assert<Equal<typeof result.value, RecordOf<Input>>>;
  assert.strictEqual(result.value.before, input); assert.equal(result.value.after.token(), 'trusted');
  const app = application(input), saved = await app.create('id'); assert(saved.ok);
  type API = Assert<Equal<Awaited<ReturnType<typeof app.create>>, Result<RecordOf<Input>, 'Refused' | 'Conflict'>>>;
  assert.strictEqual(saved.value.after, input); assert.equal(saves, 1);
  assert.deepEqual(forward(null), err('Refused'));
  assert.deepEqual(await application(null).create('id'), err('Refused')); assert.equal(saves, 1);
});

test('ordinary record inference retains unrelated unknowns, union alternatives and private classes', () => {
  const wrap = <T>(input: T): Result<{ payload: T; unrelated: unknown }, never> => ok({ payload: input, unrelated: null });
  function forward<T>(input: T) {
    return transition(defineTransition({ validate: (value: T) => ok(value), require: [wrap], evolve: value => {
      type Exact = Assert<Equal<typeof value, { payload: T; unrelated: unknown }>>;
      return ok(value);
    } })).run(input);
  }
  assert.deepEqual(forward(3), ok({ payload: 3, unrelated: null }));
  class Box<T> { #proof = true; constructor(readonly payload: T) {} proof() { return this.#proof; } }
  const boxed = <T>(input: T) => ok(new Box(input));
  const flow = transition(defineTransition({ validate: (value: number) => ok(value), require: [boxed], evolve: value => {
    type Private = Assert<Equal<typeof value, Box<unknown>>>;
    return ok(value);
  } }));
  const result = flow.run(4); assert(result.ok); assert(result.value instanceof Box); assert(result.value.proof());
  const union = <T>(input: T): Result<{ kind: 'left'; payload: T } | { kind: 'right'; count: number }, never> => ok({ kind: 'left', payload: input });
  const choice = transition(defineTransition({ validate: (value: number) => ok(value), require: [union], evolve: value => {
    if (value.kind === 'left') { type Payload = Assert<Equal<typeof value.payload, number>>; }
    else { type Count = Assert<Equal<typeof value.count, number>>; }
    return ok(value);
  } }));
  assert.deepEqual(choice.run(5), ok({ kind: 'left', payload: 5 }));
});

function rejectedOrdinaryRefinements() {
  const broad = (_input: unknown): Result<{ payload: unknown }, never> => ok({ payload: null });
  defineTransition({ validate: (value: number) => ok(value),
    // @ts-expect-error A broad monomorphic producer cannot invent a number payload.
    require: [broad, (value: { payload: number }) => ok(value)], evolve: value => ok(value),
  });
}
void rejectedOrdinaryRefinements;

function ordinaryOverlapping<T>(input: T): Result<{ a: T } | { b: unknown }, never>;
function ordinaryOverlapping<T>(input: T): Result<{ a: unknown } | { b: T }, never>;
function ordinaryOverlapping(input: unknown): Result<{ a: unknown } | { b: unknown }, never>;
function ordinaryOverlapping(_input: unknown): Result<{ a: unknown } | { b: unknown }, never> { return ok({ a: null, b: null }); }

test('ordinary records require a joint producer promise and retain private proofs', () => {
  const flow = transition(defineTransition({ validate: (value: number) => ok(value), require: [ordinaryOverlapping], evolve: value => {
    type Exact = Assert<Equal<typeof value, { a: unknown } | { b: unknown }>>;
    return ok(value);
  } }));
  assert.deepEqual(flow.run(3), ok({ a: null, b: null }));
  const proof: unique symbol = Symbol('proof');
  const trusted = <T>(payload: T): Result<{ payload: T; readonly [proof]: true }, never> => ok({ payload, [proof]: true });
  const secured = transition(defineTransition({ validate: (value: number) => ok(value), require: [trusted], evolve: value => {
    type Exact = Assert<Equal<typeof value, { payload: number; readonly [proof]: true }>>;
    return ok(value);
  } }));
  const result = secured.run(4); assert(result.ok); assert.equal(result.value[proof], true); assert.equal(result.value.payload, 4);
});
