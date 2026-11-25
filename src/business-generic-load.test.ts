import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, type Result, type Execution, type Receipt, type ReplayInputError } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ id: string }>;
type Submit = Base & Readonly<{ approver: string }>;
type Reject = Base & Readonly<{ reason: string }>;
type Loaded<I> = Readonly<{ input: I; actor: string }>;
type Submitted = Readonly<{ state: 'submitted'; by: string }>;
type Rejected = Readonly<{ state: 'rejected'; reason: string }>;
type Decision = Submitted | Rejected;
function fixture() {
  const calls: string[] = [];
  const load = async <I extends Base>(input: I): Promise<Result<Loaded<I>, 'LoadFailed'>> => {
    calls.push('load'); return input.id === 'missing' ? err('LoadFailed') : ok({ input, actor: 'host' });
  };
  const submit = (value: Loaded<Submit>): Result<Submitted, 'InvalidSubmit'> => {
    calls.push('submit'); return value.input.approver ? ok({ state: 'submitted', by: value.actor }) : err('InvalidSubmit');
  };
  const reject = (value: Loaded<Reject>): Result<Rejected, 'InvalidReason'> => {
    calls.push('reject'); return value.input.reason.trim() ? ok({ state: 'rejected', reason: value.input.reason.trim() }) : err('InvalidReason');
  };
  const save = async <T extends Decision>(value: T): Promise<Result<T, 'SaveFailed'>> => {
    calls.push('save'); return value.state === 'rejected' && value.reason === 'fail' ? err('SaveFailed') : ok(value);
  };
  return { calls, load, submit, reject, save };
}

for (const local of [false, true]) test(`generic input envelopes infer each operation request with ${local ? 'local' : 'shared'} load`, async () => {
  const f = fixture();
  const app = local ? business({ name: 'local', save: f.save, operations: {
    submit: { load: f.load, run: [f.submit] }, reject: { load: f.load, run: [f.reject] },
  } }) : business({ name: 'shared', load: f.load, save: f.save, operations: { submit: [f.submit], reject: [f.reject] } });
  type SubmitInput = Assert<Equal<Parameters<typeof app.submit>[0], Submit>>;
  type RejectInput = Assert<Equal<Parameters<typeof app.reject.run>[0], Reject>>;
  type SubmitResult = Assert<Equal<Awaited<ReturnType<typeof app.submit>>, Result<Submitted, 'LoadFailed' | 'InvalidSubmit' | 'SaveFailed'>>>;
  type RejectResult = Assert<Equal<Awaited<ReturnType<typeof app.reject>>, Result<Rejected, 'LoadFailed' | 'InvalidReason' | 'SaveFailed'>>>;
  assert.deepEqual(await app.submit({ id: 'one', approver: 'boss' }), ok({ state: 'submitted', by: 'host' }));
  assert.deepEqual(f.calls.splice(0), ['load', 'submit', 'save']);
  const detail = await app.reject.runDetailed({ id: 'one', reason: ' policy ' }, { input: () => null, result: () => null });
  assert.deepEqual(detail.result, ok({ state: 'rejected', reason: 'policy' }));
  assert.equal(detail.observations.length, 3);
  assert.deepEqual(f.calls.splice(0), ['load', 'reject', 'save']);
  assert.deepEqual(await app.submit({ id: 'missing', approver: 'boss' }), err('LoadFailed'));
  assert.deepEqual(f.calls.splice(0), ['load']);
  assert.deepEqual(await app.reject({ id: 'one', reason: ' ' }), err('InvalidReason'));
  assert.deepEqual(f.calls.splice(0), ['load', 'reject']);
  assert.deepEqual(await app.reject({ id: 'one', reason: 'fail' }), err('SaveFailed'));
  assert.deepEqual(f.calls.splice(0), ['load', 'reject', 'save']);
});

test('generic load specialization preserves replay input contracts and historical output', async () => {
  const f = fixture();
  const save = async (value: Decision): Promise<Result<Execution<Decision>, 'SaveFailed'>> => {
    f.calls.push('save'); return ok({ kind: 'committed', value });
  };
  const app = business({ name: 'replay-load', load: f.load, save, operations: { submit: [f.submit], reject: [f.reject] }, replay: {
    lookup: (execution): Result<Receipt<Decision>, 'LookupFailed'> => {
      type Requests = Assert<Equal<typeof execution.request, Submit | Reject>>;
      type Names = Assert<Equal<typeof execution.name, 'submit' | 'reject'>>;
      const request: Submit | Reject = execution.request;
      return request.id === 'cached' ? ok({ kind: 'found', value: { state: 'submitted', by: 'earlier' } }) : ok({ kind: 'missing' });
    },
    resolveAfter: [],
  } });
  type Input = Assert<Equal<Parameters<typeof app.reject>[0], Reject>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.reject>>, Result<Execution<Decision>, 'LoadFailed' | 'InvalidReason' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>>>;
  assert.deepEqual(await app.reject({ id: 'cached', reason: 'policy' }), ok({ kind: 'replayed', value: { state: 'submitted', by: 'earlier' } }));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await app.reject({ id: 'one', reason: 'policy' }), ok({ kind: 'committed', value: { state: 'rejected', reason: 'policy' } }));
  assert.deepEqual(f.calls, ['load', 'reject', 'save']);
});

test('generic load inference leaves opaque context instances intact at runtime', async () => {
  class Context<I> {
    #actor = 'host';
    constructor(readonly input: I) {}
    actor() { return this.#actor; }
  }
  const seen: object[] = [];
  const load = async <I extends Base>(input: I): Promise<Result<Context<I>, never>> => {
    const context = new Context(input); seen.push(context); return ok(context);
  };
  const submit = (context: Context<Submit>): Result<Submitted, never> => {
    seen.push(context); return ok({ state: 'submitted', by: context.actor() });
  };
  const save = async (value: Submitted) => ok(value);
  const app = business({ name: 'opaque-generic-load', load, save, operations: { submit: [submit] } });
  type Input = Assert<Equal<Parameters<typeof app.submit>[0], Submit>>;
  assert.deepEqual(await app.submit({ id: 'one', approver: 'boss' }), ok({ state: 'submitted', by: 'host' }));
  assert.equal(seen.length, 2); assert.strictEqual(seen[0], seen[1]);
});

declare const proof: unique symbol;
declare const dynamic: ReturnType<typeof fixture>['load'] | ((input: Base) => Promise<Result<Loaded<Base>, 'LoadFailed'>>);
declare const scoped: <I extends Base & { readonly tenant: 'one' }>(input: I) => Promise<Result<Loaded<I>, 'LoadFailed'>>;
declare const partial: <I extends Base>(input: I) => Promise<Result<Loaded<I> | { readonly input: I }, 'LoadFailed'>>;
function typeContracts() {
  const f = fixture(), operations = { submit: [f.submit] as const };
  const app = business({ name: 'exact', load: f.load, save: f.save, operations: { submit: [f.submit], reject: [f.reject] } });
  // @ts-expect-error the first stage requires an approver
  app.submit({ id: 'one' });
  // @ts-expect-error the first stage requires a textual reason
  app.reject({ id: 'one', reason: 1 });
  const broad = async (input: Base): Promise<Result<Loaded<Base>, 'LoadFailed'>> => ok({ input, actor: 'host' });
  // @ts-expect-error a monomorphic broad loader cannot produce the required narrow context
  business({ name: 'broad', load: broad, save: f.save, operations });
  // @ts-expect-error every dynamically selected loader must guarantee the context
  business({ name: 'dynamic', load: dynamic, save: f.save, operations });
  // @ts-expect-error the candidate request cannot omit the loader's own input constraint
  business({ name: 'scoped', load: scoped, save: f.save, operations });
  // @ts-expect-error every possible successful load value must supply the required context
  business({ name: 'partial', load: partial, save: f.save, operations });
  const missing = async <I extends Base>(input: I): Promise<Result<{ input: I }, never>> => ok({ input });
  // @ts-expect-error specializing input cannot invent the rest of the loaded context
  business({ name: 'missing-actor', load: missing, save: f.save, operations });
  const needsProof = (input: Loaded<Submit> & { readonly [proof]: true }): Result<Submitted, never> => ok({ state: 'submitted', by: input.actor });
  business({ name: 'proof', load: f.load, save: f.save, operations: {
    // @ts-expect-error the loader does not promise authorization proof
    submit: [needsProof],
  } });
  const unrelated = async (_input: string): Promise<Result<Loaded<Submit>, never>> => ok({ input: { id: 'one', approver: 'boss' }, actor: 'host' });
  const original = business({ name: 'original', load: unrelated, save: f.save, operations });
  type OriginalInput = Assert<Equal<Parameters<typeof original.submit>[0], string>>;
}
void typeContracts;
