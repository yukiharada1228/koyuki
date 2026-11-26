import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, withInput, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ id: string }>;
type Submit = Base & Readonly<{ approver: string }>;
type Actor = Readonly<{ id: string; active: boolean }>;
type Context<I> = Readonly<{ input: I; actor: Actor }>;
const verified: unique symbol = Symbol('verified');
type Verified = Readonly<{ [verified]: true }>;
const proof: Verified = { [verified]: true };
const inactive: Readonly<{ kind: 'Inactive' }> = { kind: 'Inactive' };
const invalid: Readonly<{ kind: 'InvalidActor'; actorId: string }> = { kind: 'InvalidActor', actorId: '' };
// No Result return annotation: each refusal and the proof-producing success is
// inferred independently, as in an ordinary domain function with early returns.
function check<T extends Context<Base>>(value: T) {
  if (!value.actor.active) return err(inactive);
  if (!value.actor.id) return err(invalid);
  return ok({ ...value, ...proof });
}
const approve = (value: Context<Submit> & Verified): Result<string, 'Refused'> =>
  value.actor.id === value.input.approver ? ok(value.input.id) : err('Refused');
const save = async <T extends string>(value: T): Promise<Result<T, 'SaveFailed'>> => ok(value);
function fixture(actor: Actor) {
  const calls: string[] = [];
  const load = async <I extends Base>(input: I): Promise<Result<Context<I>, 'LoadFailed'>> => {
    calls.push('load'); return ok({ input, actor });
  };
  const persist: typeof save = value => { calls.push('save'); return save(value); };
  const app = business({ name: 'inferred-check', load, save: persist, operations: { approve: [check, approve] } });
  return { app, calls };
}
test('inferred early-return checks retain a later request and the complete error union', async () => {
  const { app, calls } = fixture({ id: 'boss', active: true });
  type Input = Assert<Equal<Parameters<typeof app.approve>[0], Submit>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.approve>>, Result<string,
    'LoadFailed' | 'SaveFailed' | 'Refused' | typeof inactive | typeof invalid>>>;
  assert.deepEqual(calls, []);
  assert.deepEqual(await app.approve({ id: 'one', approver: 'boss' }), ok('one'));
  assert.deepEqual(calls, ['load', 'save']);
  if (false) {
    // @ts-expect-error Inferred checks must not make the later request field optional.
    void app.approve({ id: 'one' });
    const load = async <I extends Base>(input: I) => ok({ input, actor: { id: 'boss', active: true } });
    // @ts-expect-error The proof still has to be produced by a preceding check.
    business({ name: 'missing-check', load, save, operations: { approve: [approve] } });
  }
});
test('each inferred structured refusal stops the workflow before saving', async () => {
  for (const [actor, expected] of [[{ id: 'boss', active: false }, inactive], [{ id: '', active: true }, invalid]] as const) {
    const { app, calls } = fixture(actor);
    const report = await app.approve.runDetailed({ id: 'one', approver: 'boss' });
    assert.deepEqual(report.result, err(expected));
    assert.deepEqual(calls, ['load']);
    assert.deepEqual(report.trace.map(row => row.status), ['ok', 'error']);
  }
});
test('a specialized loader keeps its request when later stages carry a nested context', async () => {
  const load = async (input: Submit): Promise<Result<Context<Submit>, 'LoadFailed'>> => ok({ input, actor: { id: 'boss', active: true } });
  const detail = <T extends Context<Submit> & Verified>(value: T): Result<number, never> => ok(value.input.approver.length);
  const finish = (pair: Readonly<{ input: Context<Submit> & Verified; value: number }>) => ok(pair.input.input.id);
  const detailed = withInput(detail);
  const app = business({ name: 'specialized-check', load, save, operations: { approve: [check, detailed, finish] } });
  type Input = Assert<Equal<Parameters<typeof app.approve>[0], Submit>>;
  assert.deepEqual(await app.approve({ id: 'one', approver: 'boss' }), ok('one'));
});

// Keep a caller's still-generic error type as well as concrete inferred variants.
function genericFailure<E>(failure: E) {
  const load = async <I extends Base>(input: I): Promise<Result<Context<I>, 'LoadFailed'>> => ok({ input, actor: { id: 'boss', active: true } });
  const validate = <T extends Context<Base>>(value: T): Result<T & Verified, E> =>
    value.actor.active ? ok({ ...value, ...proof }) : err(failure);
  return business({ name: 'generic-failure', load, save, operations: { approve: [validate, approve] } });
}
const customFailure: Readonly<{ kind: 'CustomFailure' }> = { kind: 'CustomFailure' };
const generic = genericFailure(customFailure);
type GenericInput = Assert<Equal<Parameters<typeof generic.approve>[0], Submit>>;
type GenericOutput = Assert<Equal<Awaited<ReturnType<typeof generic.approve>>, Result<string, typeof customFailure | 'LoadFailed' | 'SaveFailed' | 'Refused'>>>;
