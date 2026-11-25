import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Input = Readonly<{ id: string; amount: number }>;
type Context = Readonly<{ input: Input; actor: Readonly<{ active: boolean }> }>;
function active<T extends { readonly actor: { readonly active: boolean } }>(value: T): Result<T, 'Inactive'> {
  return value.actor.active ? ok(value) : err('Inactive');
}
function positive<T extends { readonly input: { readonly amount: number } }>(value: T): Result<T, 'InvalidAmount'> {
  return value.input.amount > 0 ? ok(value) : err('InvalidAmount');
}
type Approved = Readonly<{ id: string; amount: number; state: 'approved' }>;
const approve = (context: Context): Result<Approved, never> => ok({ id: context.input.id, amount: context.input.amount, state: 'approved' });

test('shared generic checks preserve the loaded context and stop before evolve and save on rejection', async () => {
  const calls: string[] = [];
  const app = business({
    name: 'generic.check',
    load: async (input: Input) => { calls.push('load'); return ok({ input, actor: { active: input.id !== 'inactive' } }); },
    operations: { approve: [active, positive, (context: Context) => { calls.push('approve'); return approve(context); }] },
    save: async <T extends Approved>(value: T): Promise<Result<T, 'SaveFailed'>> => { calls.push('save'); return ok(value); },
  });
  type In = Assert<Equal<Parameters<typeof app.approve>[0], Input>>;
  type Out = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Approved, 'Inactive' | 'InvalidAmount' | 'SaveFailed'>>>;
  assert.deepEqual(await app.approve({ id: 'one', amount: 3 }), ok({ id: 'one', amount: 3, state: 'approved' }));
  assert.deepEqual(calls, ['load', 'approve', 'save']); calls.length = 0;
  assert.deepEqual(await app.approve({ id: 'inactive', amount: 3 }), err('Inactive'));
  assert.deepEqual(calls, ['load']); calls.length = 0;
  assert.deepEqual(await app.approve({ id: 'one', amount: -1 }), err('InvalidAmount'));
  assert.deepEqual(calls, ['load']);
});

test('a generic final check retains its concrete result and opaque reference', async () => {
  class Loaded {
    readonly actor = { active: true };
    #secret = 'host';
    constructor(readonly input: Input) {}
    secret() { return this.#secret; }
  }
  const value = new Loaded({ id: 'one', amount: 3 });
  let saved: Loaded | undefined;
  const app = business({ name: 'generic.final', load: async (input: Input) => { assert.strictEqual(input, value.input); return ok(value); },
    operations: { check: [active, positive] },
    save: async <T extends Loaded>(next: T): Promise<Result<T, 'SaveFailed'>> => { saved = next; assert.equal(next.secret(), 'host'); return ok(next); },
  });
  type Out = Assert<Equal<Awaited<ReturnType<typeof app.check>>, Result<Loaded, 'Inactive' | 'InvalidAmount' | 'SaveFailed'>>>;
  const result = await app.check(value.input);
  assert(result.ok); assert.strictEqual(result.value, value); assert.strictEqual(saved, value);
});

test('one shared check retains distinct operation-local contexts and detailed failure stages', async () => {
  type Text = Readonly<{ label: string }>;
  type TextContext = Readonly<{ input: Text; actor: { active: boolean } }>;
  const app = business({ name: 'generic.local',
    operations: {
      approve: { load: async (input: Input) => ok({ input, actor: { active: true } }), run: [active, positive, approve] },
      label: { load: async (input: Text) => ok({ input, actor: { active: true } }), run: [active, (value: TextContext) => ok(value.input.label)] },
    },
    save: async <T extends Approved | string>(value: T): Promise<Result<T, 'SaveFailed'>> => ok(value),
  });
  type NumberInput = Assert<Equal<Parameters<typeof app.approve>[0], Input>>;
  type TextInput = Assert<Equal<Parameters<typeof app.label>[0], Text>>;
  type NumberOut = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Approved, 'Inactive' | 'InvalidAmount' | 'SaveFailed'>>>;
  type TextOut = Assert<Equal<Awaited<ReturnType<typeof app.label>>, Result<string, 'Inactive' | 'SaveFailed'>>>;
  assert.deepEqual(await app.label({ label: 'one' }), ok('one'));
  const detail = await app.approve.runDetailed({ id: 'one', amount: -1 });
  assert.deepEqual(detail.result, err('InvalidAmount'));
  assert.deepEqual(detail.trace.map(item => [item.step, item.status]), [['generic.local.approve:load', 'ok'], ['run:1', 'ok'], ['run:2', 'error']]);
});

declare const authorized: unique symbol;
function typeContracts() {
  const load = async (input: Input) => ok({ input, actor: { active: true } });
  const save = async (value: Approved) => ok(value);
  const broad = (value: { actor: { active: boolean } }): Result<{ actor: { active: boolean } }, 'Broad'> => ok({ actor: value.actor });
  // @ts-expect-error a monomorphic broad return cannot promise the original input field
  business({ name: 'broad', load, save, operations: { approve: [broad, approve] } });
  const needsProof = (value: Context & { readonly [authorized]: true }) => approve(value);
  // @ts-expect-error identity checks do not create an authorization proof
  business({ name: 'proof', load, save, operations: { approve: [active, positive, needsProof] } });
  const secret = <T extends { secret: string }>(value: T): Result<T, 'Secret'> => ok(value);
  // @ts-expect-error the preceding context does not meet the generic rule constraint
  business({ name: 'constraint', load, save, operations: { approve: [secret, approve] } });
  const addProof = (value: Context): Result<Context & { readonly [authorized]: true }, never> => ok({ ...value, [authorized]: true });
  // A genuinely narrower result is retained, rather than replaced with its input.
  const valid = business({ name: 'narrow', load, save, operations: { approve: [addProof, active, positive, needsProof] } });
  type Out = Assert<Equal<Awaited<ReturnType<typeof valid.approve>>, Result<Approved, 'Inactive' | 'InvalidAmount'>>>;
}
void typeContracts;

function longTypeContract() {
  const app = business({ name: 'generic.long', load: async (input: Context) => ok(input), operations: { check: [
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
    active, active, active, active, active, active, active, active,
  ] }, save: async <T extends Context>(value: T): Promise<Result<T, never>> => ok(value) });
  type Out = Assert<Equal<Awaited<ReturnType<typeof app.check>>, Result<Context, 'Inactive'>>>;
}
void longTypeContract;
