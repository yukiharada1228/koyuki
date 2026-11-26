import test from 'node:test';
import assert from 'node:assert/strict';
import { business, step, ok, err, type Result, type Execution, type Receipt, type ReplayInputError } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ id: string }>;
type Submit = Base & Readonly<{ amount: number; approver: string }>;
type Actor = Readonly<{ id: string; active: boolean; role: 'manager' | 'employee' }>;
type Context<I> = Readonly<{ input: I; actor: Actor }>;
type Approved = Readonly<{ id: string; amount: number; state: 'approved' }>;
const validated: unique symbol = Symbol('validated');
const authorized: unique symbol = Symbol('authorized');
type Validated = Readonly<{ [validated]: true }>;
type Authorized = Readonly<{ [authorized]: true }>;
// Observe the public subject ID, rather than serializing private proof keys.
function subjectId(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const subject = 'input' in value ? value.input : value;
  return subject !== null && typeof subject === 'object' && 'id' in subject && typeof subject.id === 'string' ? subject.id : null;
}
function fixture(actor: Actor = { id: 'boss', active: true, role: 'manager' }) {
  const calls: string[] = [];
  const load = async <I extends Base>(input: I): Promise<Result<Context<I>, 'LoadFailed'>> => {
    calls.push('load'); return input.id === 'missing' ? err('LoadFailed') : ok({ input, actor });
  };
  const validate = <T extends { readonly actor: Actor }>(value: T): Result<T & Validated, 'Inactive'> => {
    calls.push('validate'); return value.actor.active ? ok({ ...value, [validated]: true }) : err('Inactive');
  };
  const authorize = <T extends Context<Submit> & Validated>(value: T): Result<T & Authorized, 'Denied'> => {
    calls.push('authorize');
    return value.actor.role === 'manager' && value.actor.id === value.input.approver ? ok({ ...value, [authorized]: true }) : err('Denied');
  };
  const approve = (value: Context<Submit> & Validated & Authorized): Result<Approved, 'InvalidAmount'> => {
    calls.push('approve'); assert.equal(value[validated], true); assert.equal(value[authorized], true);
    return value.input.amount > 0 ? ok({ id: value.input.id, amount: value.input.amount, state: 'approved' }) : err('InvalidAmount');
  };
  const save = async <T extends Approved>(value: T): Promise<Result<T, 'SaveFailed'>> => {
    calls.push('save'); return value.id === 'save-failed' ? err('SaveFailed') : ok(value);
  };
  return { calls, load, validate, authorize, approve, save };
}
function application(f: ReturnType<typeof fixture>, local: boolean) {
  return local ? business({ name: 'local-proof', save: f.save, operations: {
    approve: { load: f.load, run: [step('active', f.validate), f.authorize, f.approve] },
  } }) : business({ name: 'shared-proof', load: f.load, save: f.save, operations: {
    approve: [step('active', f.validate), f.authorize, f.approve],
  } });
}
for (const local of [false, true]) test(`proof-producing checks preserve later request inference with ${local ? 'local' : 'shared'} load`, async () => {
  const f = fixture(), app = application(f, local), input = { id: 'one', amount: 3, approver: 'boss' };
  type Request = Assert<Equal<Parameters<typeof app.approve>[0], Submit>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Approved, 'LoadFailed' | 'Inactive' | 'Denied' | 'InvalidAmount' | 'SaveFailed'>>>;
  assert.deepEqual(f.calls, []);
  const detail = await app.approve.runDetailed(input, { input: subjectId, result: result => result.ok ? subjectId(result.value) : null });
  assert.deepEqual(detail.result, ok({ id: 'one', amount: 3, state: 'approved' }));
  assert.equal(detail.observations.length, 5); assert(detail.trace.every(row => row.status === 'ok'));
  assert(detail.observations.every(row => row.input === 'one' && row.result === 'one'));
  assert.deepEqual(detail.observationErrors, []);
  assert.deepEqual(f.calls, ['load', 'validate', 'authorize', 'approve', 'save']);
  assert.deepEqual(input, { id: 'one', amount: 3, approver: 'boss' });
  if (false) {
    // @ts-expect-error Neither a later request field nor a proof may be inferred as optional.
    void app.approve({ id: 'one', amount: 3 });
  }
});

test('proof-producing stages stop at the first refusal, without saving', async () => {
  const request: Submit = { id: 'one', amount: 3, approver: 'boss' };
  for (const [input, actor, error, expected] of [
    [{ ...request, id: 'missing' }, { id: 'boss', active: true, role: 'manager' }, 'LoadFailed', ['load']],
    [request, { id: 'boss', active: false, role: 'manager' }, 'Inactive', ['load', 'validate']],
    [request, { id: 'boss', active: true, role: 'employee' }, 'Denied', ['load', 'validate', 'authorize']],
    [{ ...request, amount: 0 }, { id: 'boss', active: true, role: 'manager' }, 'InvalidAmount', ['load', 'validate', 'authorize', 'approve']],
    [{ ...request, id: 'save-failed' }, { id: 'boss', active: true, role: 'manager' }, 'SaveFailed', ['load', 'validate', 'authorize', 'approve', 'save']],
  ] as const) {
    const f = fixture(actor), app = application(f, false);
    assert.deepEqual(await app.approve(input), err(error)); assert.deepEqual(f.calls, expected);
  }
});

test('verified-request inference also preserves replay inputs and errors', async () => {
  const f = fixture();
  const save = async (value: Approved): Promise<Result<Execution<Approved>, 'SaveFailed'>> => { f.calls.push('save'); return ok({ kind: 'committed', value }); };
  const app = business({ name: 'proof-replay', load: f.load, save, operations: { approve: [f.validate, f.authorize, f.approve] }, replay: {
    lookup: (execution): Result<Receipt<Approved>, 'LookupFailed'> => {
      type Request = Assert<Equal<typeof execution.request, Submit>>;
      type Name = Assert<Equal<typeof execution.name, 'approve'>>;
      return execution.request.id === 'cached' ? ok({ kind: 'found', value: { id: 'cached', amount: 9, state: 'approved' } }) : ok({ kind: 'missing' });
    }, resolveAfter: [],
  } });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<Execution<Approved>, 'LoadFailed' | 'Inactive' | 'Denied' | 'InvalidAmount' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>>>;
  assert.deepEqual(await app.approve({ id: 'cached', amount: 3, approver: 'boss' }), ok({ kind: 'replayed', value: { id: 'cached', amount: 9, state: 'approved' } }));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await app.approve({ id: 'one', amount: 3, approver: 'boss' }), ok({ kind: 'committed', value: { id: 'one', amount: 3, state: 'approved' } }));
  assert.deepEqual(f.calls, ['load', 'validate', 'authorize', 'approve', 'save']);
});

declare const selected: ReturnType<typeof fixture>['load'] | ((input: Base) => Promise<Result<Context<Base>, 'LoadFailed'>>);
function refusals() {
  const f = fixture();
  const identity = <T extends Context<Base>>(value: T) => ok(value);
  // @ts-expect-error The required validation proof was never produced.
  business({ name: 'missing-validation', load: f.load, save: f.save, operations: { approve: [identity, f.authorize, f.approve] } });
  // @ts-expect-error Validation alone cannot stand in for authorization.
  business({ name: 'missing-authorization', load: f.load, save: f.save, operations: { approve: [f.validate, f.approve] } });
  // @ts-expect-error Validated state cannot be used before it is produced.
  business({ name: 'reversed', load: f.load, save: f.save, operations: { approve: [f.authorize, f.validate, f.approve] } });
  // @ts-expect-error One selected loader cannot supply the actual request fields.
  business({ name: 'selected', load: selected, save: f.save, operations: { approve: [f.validate, f.authorize, f.approve] } });
  const broad = <T extends Context<Base>>(value: T): Result<Context<Base> & Validated, never> => ok({ input: { id: value.input.id }, actor: value.actor, [validated]: true });
  // @ts-expect-error Adding a proof does not preserve a request the producer drops.
  business({ name: 'dropped', load: f.load, save: f.save, operations: { approve: [broad, f.authorize, f.approve] } });
  const boxed = <T extends Context<Base>>(value: T): Result<Context<Base> & Validated & { box: T }, never> => ok({ input: { id: value.input.id }, actor: value.actor, box: value, [validated]: true });
  // @ts-expect-error Keeping T in a nested field is not preservation of the root context.
  business({ name: 'boxed', load: f.load, save: f.save, operations: { approve: [boxed, f.authorize, f.approve] } });
}
void refusals;
