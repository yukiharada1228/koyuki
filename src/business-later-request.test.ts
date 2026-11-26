import test from 'node:test';
import assert from 'node:assert/strict';
import { business, step, ok, err, type Result, type Execution, type Receipt, type ReplayInputError } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ id: string }>;
type Submit = Base & Readonly<{ approver: string }>;
type Reject = Base & Readonly<{ reason: string }>;
type Context<I> = Readonly<{ input: I; actor: string }>;
type Submitted = Readonly<{ state: 'submitted'; by: string }>;
type Rejected = Readonly<{ state: 'rejected'; reason: string }>;
function fixture() {
  const calls: string[] = [];
  const load = async <I extends Base>(input: I): Promise<Result<Context<I>, 'LoadFailed'>> => {
    calls.push('load'); return input.id === 'missing' ? err('LoadFailed') : ok({ input, actor: 'host' });
  };
  const common = <T extends Context<Base>>(value: T): Result<T, 'Denied'> => {
    calls.push('common'); return value.input.id === 'denied' ? err('Denied') : ok(value);
  };
  const extra = <T extends Context<Base>>(value: T): Result<T, never> => { calls.push('extra'); return ok(value); };
  const submit = (value: Context<Submit>): Result<Submitted, 'InvalidSubmit'> => {
    calls.push('submit'); return value.input.approver ? ok({ state: 'submitted', by: value.actor }) : err('InvalidSubmit');
  };
  const reject = (value: Context<Reject>): Result<Rejected, 'InvalidReason'> => {
    calls.push('reject'); return value.input.reason.trim() ? ok({ state: 'rejected', reason: value.input.reason.trim() }) : err('InvalidReason');
  };
  const save = async <T extends Submitted | Rejected>(value: T): Promise<Result<T, 'SaveFailed'>> => {
    calls.push('save'); return value.state === 'rejected' && value.reason === 'fail' ? err('SaveFailed') : ok(value);
  };
  return { calls, load, common, extra, submit, reject, save };
}
for (const local of [false, true]) test(`later requests survive shared identity checks with ${local ? 'local' : 'shared'} load`, async () => {
  const f = fixture();
  const app = local ? business({ name: 'local', save: f.save, operations: {
    submit: { load: f.load, run: [step('common', f.common), f.extra, f.submit] },
    reject: { load: f.load, run: [f.common, f.reject] },
  } }) : business({ name: 'shared', load: f.load, save: f.save, operations: {
    submit: [step('common', f.common), f.extra, f.submit], reject: [f.common, f.reject],
  } });
  type Request = Assert<Equal<Parameters<typeof app.submit>[0], Submit>>;
  type RejectRequest = Assert<Equal<Parameters<typeof app.reject>[0], Reject>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.submit>>, Result<Submitted, 'LoadFailed' | 'Denied' | 'InvalidSubmit' | 'SaveFailed'>>>;
  assert.deepEqual(await app.submit({ id: 'one', approver: 'boss' }), ok({ state: 'submitted', by: 'host' }));
  assert.deepEqual(f.calls.splice(0), ['load', 'common', 'extra', 'submit', 'save']);
  const detail = await app.reject.runDetailed({ id: 'one', reason: ' policy ' }, { input: () => null, result: () => null });
  assert.deepEqual(detail.result, ok({ state: 'rejected', reason: 'policy' })); assert.equal(detail.observations.length, 4);
  assert.deepEqual(f.calls.splice(0), ['load', 'common', 'reject', 'save']);
  for (const [request, expected, calls] of [
    [{ id: 'missing', reason: 'x' }, 'LoadFailed', ['load']],
    [{ id: 'denied', reason: 'x' }, 'Denied', ['load', 'common']],
    [{ id: 'one', reason: ' ' }, 'InvalidReason', ['load', 'common', 'reject']],
    [{ id: 'one', reason: 'fail' }, 'SaveFailed', ['load', 'common', 'reject', 'save']],
  ] as const) {
    assert.deepEqual(await app.reject(request), err(expected)); assert.deepEqual(f.calls.splice(0), calls);
  }
  if (false) {
    // @ts-expect-error A common check does not remove the later required field.
    void app.submit({ id: 'one' });
    // @ts-expect-error The other operation keeps its own required field.
    void app.reject({ id: 'one', approver: 'boss' });
  }
});

test('an already valid pipeline that replaces input keeps the original request domain', async () => {
  const f = fixture();
  const replace = (_value: Context<Base>) => ok({ input: { derived: true as const } });
  const finish = (value: { input: { derived: true } }) => ok(value.input.derived);
  const app = business({ name: 'replace', load: f.load, save: async (value: true) => ok(value), operations: { run: [f.common, replace, finish] } });
  type Request = Assert<Equal<Parameters<typeof app.run>[0], Base>>;
  assert.deepEqual(await app.run({ id: 'one' }), ok(true));
});

test('requirements from distinct identity stages are retained together', async () => {
  const f = fixture(); type Both = Submit & Reject;
  const approver = <T extends Context<Submit>>(value: T): Result<T, never> => ok(value);
  const reason = <T extends Context<Reject>>(value: T): Result<T, never> => ok(value);
  const finish = ({ input }: Context<Both>) => ok(input.approver + ':' + input.reason);
  const app = business({ name: 'both', load: f.load, save: async (value: string) => ok(value), operations: { run: [f.common, approver, reason, finish] } });
  type Request = Assert<Equal<Parameters<typeof app.run>[0], Both>>;
  assert.deepEqual(await app.run({ id: 'one', approver: 'boss', reason: 'policy' }), ok('boss:policy'));
  if (false) {
    // @ts-expect-error Neither requirement can be dropped from the request.
    void app.run({ id: 'one', reason: 'policy' });
  }
});

test('later requests also reach replay lookup and keep committed history broader than one operation', async () => {
  const f = fixture(); type Decision = Submitted | Rejected;
  const save = async (value: Decision): Promise<Result<Execution<Decision>, 'SaveFailed'>> => {
    f.calls.push('save'); return ok({ kind: 'committed', value });
  };
  const app = business({ name: 'later-replay', load: f.load, save, operations: {
    submit: [f.common, f.submit], reject: [f.common, f.reject],
  }, replay: {
    lookup: (execution): Result<Receipt<Decision>, 'LookupFailed'> => {
      type Requests = Assert<Equal<typeof execution.request, Submit | Reject>>;
      type Names = Assert<Equal<typeof execution.name, 'submit' | 'reject'>>;
      return execution.request.id === 'cached' ? ok({ kind: 'found', value: { state: 'submitted', by: 'earlier' } }) : ok({ kind: 'missing' });
    }, resolveAfter: [],
  } });
  type Request = Assert<Equal<Parameters<typeof app.reject>[0], Reject>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.reject>>, Result<Execution<Decision>, 'LoadFailed' | 'Denied' | 'InvalidReason' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>>>;
  assert.deepEqual(await app.reject({ id: 'cached', reason: 'policy' }), ok({ kind: 'replayed', value: { state: 'submitted', by: 'earlier' } }));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await app.reject({ id: 'one', reason: 'policy' }), ok({ kind: 'committed', value: { state: 'rejected', reason: 'policy' } }));
  assert.deepEqual(f.calls, ['load', 'common', 'reject', 'save']);
});

declare const proof: unique symbol;
declare const selected: ReturnType<typeof fixture>['load'] | ((input: Base) => Promise<Result<Context<Base>, 'LoadFailed'>>);
declare const partial: <I extends Base>(input: I) => Promise<Result<Context<I> | { readonly input: I }, 'LoadFailed'>>;
declare const conditional: <I extends Base>(input: I) => Promise<Result<Readonly<{ input: I; actor: I extends Submit ? number : string }>, 'LoadFailed'>>;
declare const scoped: <I extends Base & { tenant: 'one' }>(input: I) => Promise<Result<Context<I>, 'LoadFailed'>>;
function refusals() {
  const f = fixture();
  const broad = (value: Context<Base>): Result<Context<Base>, never> => ok({ input: { id: value.input.id }, actor: value.actor });
  // @ts-expect-error A broad producer cannot promise to preserve extra request fields.
  business({ name: 'broad-rule', load: f.load, save: f.save, operations: { run: [broad, f.submit] } });
  // @ts-expect-error One loader alternative does not guarantee the specialized context.
  business({ name: 'selected', load: selected, save: f.save, operations: { run: [f.common, f.submit] } });
  // @ts-expect-error A conditional loader changes actor for the later request subtype.
  business({ name: 'conditional', load: conditional, save: f.save, operations: { run: [f.common, f.submit] } });
  // @ts-expect-error One successful load alternative lacks the actor required by common.
  business({ name: 'partial', load: partial, save: f.save, operations: { run: [f.common, f.submit] } });
  // @ts-expect-error Later request fields cannot erase the loader's tenant constraint.
  business({ name: 'scoped', load: scoped, save: f.save, operations: { run: [f.common, f.submit] } });
  const authorized = (value: Context<Submit> & { readonly [proof]: true }) => f.submit(value);
  // @ts-expect-error No producer supplies the required authorization proof.
  business({ name: 'proof', load: f.load, save: f.save, operations: { run: [f.common, authorized] } });
  // @ts-expect-error Erasing request fields after a valid identity prefix is still rejected.
  business({ name: 'erase', load: f.load, save: f.save, operations: { run: [f.common, broad, f.submit] } });
}
void refusals;
