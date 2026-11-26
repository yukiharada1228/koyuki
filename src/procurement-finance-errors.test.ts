import test from 'node:test';
import assert from 'node:assert/strict';
import { business, workflow, defineTransition, transition, withInput, step, ok, err, type Result, type Rule } from './framework/index.js';
import { checkInvoiceRegistration, checkInvoiceMatching, checkPaymentRecording, checkPaymentCancellation, checkInvoice,
  approveCheckedInvoice, voidCheckedInvoice, registerInvoice, matchInvoice, approveInvoice, voidInvoice, recordPayment, cancelPayment, type CheckedPaymentRecording, type Payment } from './experiments/procurement/domain.js';
import { procurement, procurementChanges } from './experiments/procurement/application.js';
import { plainProcurement, plainWithCommit } from './experiments/procurement/plain.js';
import { helperProcurement, helperWithCommit } from './experiments/procurement/helper.js';
import { baselineDetail } from './experiments/procurement/baseline-detail.js';
import { baselineReplay } from './experiments/procurement/baseline-replay.js';
import { procurementReplay, type ReplayRepository } from './experiments/procurement/replay.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { story, actor, policy } from './experiments/procurement/comparison-scenario.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Fn = (...args: never[]) => unknown;
type Failed<R> = R extends { ok: false; error: infer E } ? E : never;
type Kind<E> = E extends { kind: infer K } ? K : never;
type ErrorKind<F> = F extends Fn ? Kind<Failed<Awaited<ReturnType<F>>>> : never;
type DetailKind<C> = C extends { runDetailed: infer F extends Fn } ? Awaited<ReturnType<F>> extends { result: infer R } ? Kind<Failed<R>> : never : never;
type Member<T, G extends PropertyKey, N extends PropertyKey> = G extends keyof T ? N extends keyof T[G] ? T[G][N] : never : never;
type FinanceKinds<T> = [ErrorKind<Member<T, 'invoices', 'register'>>, ErrorKind<Member<T, 'invoices', 'match'>>, ErrorKind<Member<T, 'invoices', 'approve'>>,
  ErrorKind<Member<T, 'invoices', 'void'>>, ErrorKind<Member<T, 'payments', 'record'>>, ErrorKind<Member<T, 'payments', 'cancel'>>];
type FinanceDetails<T> = [DetailKind<Member<T, 'invoices', 'register'>>, DetailKind<Member<T, 'invoices', 'match'>>, DetailKind<Member<T, 'invoices', 'approve'>>,
  DetailKind<Member<T, 'invoices', 'void'>>, DetailKind<Member<T, 'payments', 'record'>>, DetailKind<Member<T, 'payments', 'cancel'>>];
type Run<C> = C extends { run: infer F } ? F : never;
type ReplayKinds<T> = [ErrorKind<Run<Member<T, 'invoices', 'register'>>>, ErrorKind<Run<Member<T, 'invoices', 'match'>>>, ErrorKind<Run<Member<T, 'invoices', 'approve'>>>,
  ErrorKind<Run<Member<T, 'invoices', 'void'>>>, ErrorKind<Run<Member<T, 'payments', 'record'>>>, ErrorKind<Run<Member<T, 'payments', 'cancel'>>>];
type Common = 'Denied' | 'TargetMismatch' | 'InvalidInput' | 'Conflict' | 'WrongState';
type Loaded = Common | 'NotFound';
type Expected = [Loaded | 'AlreadyExists', Loaded | 'InvoiceMismatch', Loaded, Loaded, Loaded | 'AlreadyExists', Loaded];
type ReplayOnly = 'InvalidReplayRequest' | 'ReplayMismatch' | 'CommitUnknown' | 'ReplayInputNotCloneable';
type WithReplay<T extends readonly unknown[]> = { [K in keyof T]: T[K] | ReplayOnly };
type Replayed = WithReplay<Expected>;
type GuardContracts = [
  Assert<Equal<ErrorKind<typeof registerInvoice>, Common | 'AlreadyExists'>>,
  Assert<Equal<ErrorKind<typeof matchInvoice>, Common | 'InvoiceMismatch'>>,
  Assert<Equal<ErrorKind<typeof approveInvoice>, Common>>,
  Assert<Equal<ErrorKind<typeof voidInvoice>, Common>>,
  Assert<Equal<ErrorKind<typeof recordPayment>, Common | 'AlreadyExists'>>,
  Assert<Equal<ErrorKind<typeof cancelPayment>, Common>>,
  Assert<Equal<ErrorKind<typeof checkInvoiceRegistration>, Common | 'AlreadyExists'>>,
  Assert<Equal<ErrorKind<typeof checkInvoiceMatching>, Common | 'InvoiceMismatch'>>,
  Assert<Equal<ErrorKind<typeof checkPaymentRecording>, Common | 'AlreadyExists'>>,
  Assert<Equal<ErrorKind<typeof checkPaymentCancellation>, Common>>,
  Assert<Equal<ErrorKind<typeof checkInvoice>, Exclude<Common, 'WrongState'>>>,
  Assert<Equal<ErrorKind<typeof approveCheckedInvoice>, 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof voidCheckedInvoice>, 'WrongState' | 'InvalidInput'>>,
];

function publicErrorContracts(repository: SqliteProcurement) {
  const commands = procurement(repository, actor('finance'), policy), detailed = procurementChanges(repository, actor('finance'), policy);
  const plain = plainProcurement(repository, actor('finance'), policy), helper = helperProcurement(repository, actor('finance'), policy);
  const plainDetail = baselineDetail(plainProcurement, repository, actor('finance'), policy), helperDetail = baselineDetail(helperProcurement, repository, actor('finance'), policy);
  type Normal = Assert<Equal<FinanceKinds<typeof commands>, Expected>>;
  type Changes = Assert<Equal<FinanceKinds<typeof detailed>, Expected>>;
  type Plain = Assert<Equal<FinanceKinds<typeof plain>, Expected>>;
  type Helper = Assert<Equal<FinanceKinds<typeof helper>, Expected>>;
  type Detail = Assert<Equal<FinanceDetails<typeof commands>, Expected>>;
  type PlainDetail = Assert<Equal<FinanceDetails<typeof plainDetail>, Expected>>;
  type HelperDetail = Assert<Equal<FinanceDetails<typeof helperDetail>, Expected>>;
  const replay = procurementReplay(repository, actor('finance'), policy), plainReplay = baselineReplay('plain', repository, actor('finance'), policy), helperReplay = baselineReplay('helper', repository, actor('finance'), policy);
  type History<C> = C extends { run: infer F extends Fn } ? Awaited<ReturnType<F>> extends infer R
    ? R extends { ok: true; value: { value: { result: infer V } } } ? V : never : never : never;
  type KoyukiHistory = Assert<Equal<History<typeof replay.payments.record>, Payment>>;
  type PlainHistory = Assert<Equal<History<typeof plainReplay.payments.record>, Payment>>;
  type HelperHistory = Assert<Equal<History<typeof helperReplay.payments.record>, Payment>>;
  type Replay = Assert<Equal<ReplayKinds<typeof replay>, Replayed>>;
  type ReplayDetail = Assert<Equal<FinanceDetails<typeof replay>, Replayed>>;
  type PlainReplay = Assert<Equal<ReplayKinds<typeof plainReplay>, Replayed>>;
  type HelperReplay = Assert<Equal<ReplayKinds<typeof helperReplay>, Replayed>>;
  type PlainReplayDetail = Assert<Equal<FinanceDetails<typeof plainReplay>, Replayed>>;
  type HelperReplayDetail = Assert<Equal<FinanceDetails<typeof helperReplay>, Replayed>>;
  async function rejectImpossiblePaymentKind() {
    const result = await commands.payments.record({ id: 'iv', expectedVersion: 1, paymentId: 'pay', reference: 'bank' });
    if (!result.ok) {
      // @ts-expect-error A payment record cannot report QuantityExceeded.
      if (result.error.kind === 'QuantityExceeded') throw Error('InventedErrorKind');
    }
  }
  void rejectImpossiblePaymentKind;
}
void publicErrorContracts;

const normalBuilders = {
  koyuki: procurement,
  plain: plainProcurement,
  helper: helperProcurement,
};
for (const [name, build] of Object.entries(normalBuilders)) test(`finance errors retain actual rejection values and never save failures: ${name}`, async () => {
  const repository = new MemoryProcurement(); await story(procurement, repository);
  const finance = actor('finance'), commands = build(repository, finance, policy), missing = { id: 'missing', expectedVersion: 1 };
  const order = repository.read('order', 'po', finance), invoice = repository.read('invoice', 'inv', finance), voided = repository.read('invoice', 'voided', finance), payment = repository.read('payment', 'pay', finance);
  assert(order.ok && invoice.ok && voided.ok && payment.ok);
  const calls = {
    register: () => commands.invoices.register({ id: 'po', expectedVersion: order.value.version, invoiceId: 'next', amountCents: 1000 }),
    match: () => commands.invoices.match({ id: 'inv', expectedVersion: invoice.value.version }),
    approve: () => commands.invoices.approve({ id: 'inv', expectedVersion: invoice.value.version }),
    void: () => commands.invoices.void({ id: 'inv', expectedVersion: invoice.value.version, reason: 'reason' }),
    record: () => commands.payments.record({ id: 'voided', expectedVersion: voided.value.version, paymentId: 'next', reference: 'bank-2' }),
    cancel: () => commands.payments.cancel({ id: 'pay', expectedVersion: payment.value.version, reason: 'reason' }),
  };
  const before = repository.commits;
  for (const call of Object.values(calls)) assert.deepEqual(await call(), err({ kind: 'WrongState' }));
  const misses = [commands.invoices.register({ ...missing, invoiceId: 'next', amountCents: 1000 }), commands.invoices.match(missing), commands.invoices.approve(missing),
    commands.invoices.void({ ...missing, reason: 'reason' }), commands.payments.record({ ...missing, paymentId: 'next', reference: 'bank-2' }), commands.payments.cancel({ ...missing, reason: 'reason' })];
  for (const result of await Promise.all(misses)) assert.deepEqual(result, err({ kind: 'NotFound' }));
  assert.equal(repository.commits, before);
});

test('custom commit errors retain their payload and tag through normal and detailed finance execution', async () => {
  type AdapterError = Readonly<{ kind: 'AdapterRejected'; code: number }>;
  const repository = new MemoryProcurement(); await story(procurement, repository);
  let attempts = 0;
  const port: ProcurementRepository<AdapterError> = { read: repository.read.bind(repository), related: repository.related.bind(repository),
    commit: async () => { attempts++; return err({ kind: 'AdapterRejected', code: 7 }); } };
  const finance = actor('finance'), invoice = repository.read('invoice', 'inv', finance); assert(invoice.ok);
  const commands = procurement(port, finance, policy), plain = plainWithCommit(port, finance, policy), helper = helperWithCommit(port, finance, policy);
  type Kinds = Assert<Equal<ErrorKind<typeof commands.payments.record>, Expected[4] | 'AdapterRejected'>>;
  type Plain = Assert<Equal<ErrorKind<typeof plain.payments.record>, Expected[4] | 'AdapterRejected'>>;
  type Helper = Assert<Equal<ErrorKind<typeof helper.payments.record>, Expected[4] | 'AdapterRejected'>>;
  const input = { id: 'inv', expectedVersion: invoice.value.version, paymentId: 'next', reference: 'bank-2' };
  class Metadata { #token = 'private'; token() { return this.#token; } }
  const loaded = { input, actor: finance, current: invoice.value, alreadyRecorded: false as const, metadata: new Metadata() };
  const carried = withInput(checkPaymentRecording), prepared = carried(loaded); assert(prepared.ok);
  type CarriedInput = Assert<Equal<typeof prepared.value.input, typeof loaded>>;
  type CarriedValue = Assert<Equal<typeof prepared.value.value, CheckedPaymentRecording<typeof loaded>>>;
  type CarriedErrors = Assert<Equal<ErrorKind<typeof carried>, Common | 'AlreadyExists'>>;
  assert.strictEqual(prepared.value.input, loaded); assert.strictEqual(prepared.value.value, loaded);
  assert.equal(prepared.value.value.metadata.token(), 'private');
  const before = repository.commits;
  const results = [await commands.payments.record(input), await plain.payments.record(input), await helper.payments.record(input)];
  for (const result of results) {
    if (!result.ok && result.error.kind === 'AdapterRejected') { const code: number = result.error.code; assert.equal(code, 7); }
    assert.deepEqual(result, err({ kind: 'AdapterRejected', code: 7 }));
  }
  const detail = await commands.payments.record.runDetailed(input);
  if (!detail.result.ok && detail.result.error.kind === 'AdapterRejected') { const code: number = detail.result.error.code; assert.equal(code, 7); }
  assert.deepEqual(detail.result, err({ kind: 'AdapterRejected', code: 7 }));
  assert.equal(attempts, 4); assert.equal(repository.commits, before);
});

const replayBuilders = {
  koyuki: procurementReplay,
  plain: (repository: ReplayRepository) => baselineReplay('plain', repository, actor('finance'), policy),
  helper: (repository: ReplayRepository) => baselineReplay('helper', repository, actor('finance'), policy),
};
for (const [name, build] of Object.entries(replayBuilders)) test(`finance replay retains domain, lookup, snapshot and mismatch errors: ${name}`, async () => {
  const repository = new SqliteProcurement(':memory:', 'g1');
  try {
    await story(procurement, repository);
    const finance = actor('finance'), commands = build(repository, finance, policy), invoice = repository.read('invoice', 'inv', finance); assert(invoice.ok);
    const invalid = await commands.invoices.approve.runDetailed({ requestId: 'already-approved', input: { id: 'inv', expectedVersion: invoice.value.version } });
    assert.deepEqual(invalid.result, err({ kind: 'WrongState' }));
    const missing = await commands.payments.record.run({ requestId: 'missing', input: { id: 'missing', expectedVersion: 1, paymentId: 'next', reference: 'bank-2' } });
    assert.deepEqual(missing, err({ kind: 'NotFound' }));
    const input = { id: 'inv', expectedVersion: invoice.value.version, paymentId: 'next', reference: 'bank-2' };
    const uncloneable = { ...input, extra: () => 1 };
    assert.deepEqual(await commands.payments.record.run({ requestId: 'uncloneable', input: uncloneable }), err({ kind: 'ReplayInputNotCloneable' }));
    const brokenLookup: ReplayRepository = { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository),
      commitExecution: repository.commitExecution.bind(repository), lookupExecution: () => err({ kind: 'CommitUnknown' }) };
    assert.deepEqual(await build(brokenLookup, finance, policy).payments.record.run({ requestId: 'lookup', input }), err({ kind: 'CommitUnknown' }));
    const call = { requestId: 'record-next', input }, created = await commands.payments.record.run(call); assert(created.ok); assert.equal(created.value.kind, 'committed');
    const historical = await commands.payments.record.run(call); assert(historical.ok); assert.equal(historical.value.kind, 'replayed');
    type History = Assert<Equal<typeof historical.value.value.result, Payment>>;
    assert.equal(historical.value.value.result.state, 'recorded');
    const mismatch = await commands.payments.record.run({ ...call, input: { ...input, reference: 'bank-3' } });
    assert.deepEqual(mismatch, err({ kind: 'ReplayMismatch' }));
  } finally { repository.close(); }
});


test('ordinary inferred error unions retain payloads through workflow, transition and business', async () => {
  const validate = (value: number) => value === 0 ? err({ kind: 'Zero' as const, supplied: value })
    : value < 0 ? err({ kind: 'Negative' as const, min: 0 }) : ok(value);
  const double = (value: number) => ok(value * 2);
  const composed = workflow('validate', validate).then('double', double);
  const declared = transition(defineTransition({ validate, evolve: double }));
  type WorkflowErrors = Assert<Equal<ErrorKind<typeof composed.run>, 'Zero' | 'Negative'>>;
  type TransitionErrors = Assert<Equal<ErrorKind<typeof declared.run>, 'Zero' | 'Negative'>>;
  for (const run of [composed.run.bind(composed), declared.run.bind(declared)]) {
    const failed = run(-1);
    if (!failed.ok && failed.error.kind === 'Negative') { const min: number = failed.error.min; assert.equal(min, 0); }
    assert.deepEqual(failed, err({ kind: 'Negative', min: 0 }));
    assert.deepEqual(run(0), err({ kind: 'Zero', supplied: 0 })); assert.deepEqual(run(2), ok(4));
  }
  const commands = business({ name: 'inferred-errors', load: async (value: number) => value === 9 ? err({ kind: 'LoadUnavailable' as const }) : ok(value),
    save: async (value: number) => value > 10 ? err({ kind: 'SaveUnavailable' as const, retryAfter: 5 }) : ok(value), operations: { run: [validate, double] },
  });
  type PublicErrors = Assert<Equal<ErrorKind<typeof commands.run>, 'Zero' | 'Negative' | 'LoadUnavailable' | 'SaveUnavailable'>>;
  assert.deepEqual(await commands.run(9), err({ kind: 'LoadUnavailable' }));
  assert.deepEqual(await commands.run(-1), err({ kind: 'Negative', min: 0 }));
  assert.deepEqual(await commands.run(0), err({ kind: 'Zero', supplied: 0 }));
  const saved = await commands.run(6);
  if (!saved.ok && saved.error.kind === 'SaveUnavailable') { const delay: number = saved.error.retryAfter; assert.equal(delay, 5); }
  assert.deepEqual(saved, err({ kind: 'SaveUnavailable', retryAfter: 5 }));
  assert.deepEqual(await commands.run(2), ok(4));
});


test('withInput accepts inferred structured error variants without inventing a common first error', () => {
  const zero = err({ kind: 'Zero' as const, supplied: 0 }), negative = err({ kind: 'Negative' as const, min: 0 });
  const validate = (value: number) => value === 0 ? zero : value < 0 ? negative : ok(value);
  const carried = withInput(validate);
  type Errors = Assert<Equal<ErrorKind<typeof carried>, 'Zero' | 'Negative'>>;
  const failed = carried(-1);
  if (!failed.ok && failed.error.kind === 'Negative') { const min: number = failed.error.min; assert.equal(min, 0); }
  assert.strictEqual(failed, negative); assert.strictEqual(carried(0), zero);
  const success = carried(2); assert(success.ok); assert.deepEqual(success.value, { input: 2, value: 2 }); assert(Object.isFrozen(success.value));
  const flow = transition(defineTransition({ validate: (value: number) => ok(value), require: [step('structured', carried)], evolve: pair => ok(pair.input + pair.value) }));
  type ConnectedErrors = Assert<Equal<ErrorKind<typeof flow.run>, 'Zero' | 'Negative'>>;
  assert.deepEqual(flow.run(2), ok(4)); assert.strictEqual(flow.run(-1), negative);
  const inline = transition(defineTransition({ validate: (value: number) => ok(value), require: [step('structured', withInput(validate))], evolve: pair => ok(pair.input + pair.value) }));
  type InlineErrors = Assert<Equal<ErrorKind<typeof inline.run>, 'Zero' | 'Negative'>>;
  assert.deepEqual(inline.run(2), ok(4)); assert.strictEqual(inline.run(-1), negative);
  const unavailable = (_value: number) => err({ kind: 'Unavailable' as const, retryAfter: 30 });
  const selected = (available: boolean) => {
    const rule = available ? validate : unavailable;
    return withInput((value: number) => rule(value));
  };
  type Alternatives = Assert<Equal<ErrorKind<ReturnType<typeof selected>>, 'Zero' | 'Negative' | 'Unavailable'>>;
  assert.deepEqual(selected(false)(2), err({ kind: 'Unavailable', retryAfter: 30 }));
  const legacy: <I, O, E>(rule: Rule<I, O, E>) => (input: I) => Result<Readonly<{ input: I; value: O }>, E> = withInput;
  const explicit = withInput<number, number, 'Denied'>((value: number): Result<number, 'Denied'> => ok(value));
  type Explicit = Assert<Equal<ReturnType<typeof explicit>, Result<Readonly<{ input: number; value: number }>, 'Denied'>>>;
  assert.deepEqual(legacy((value: number) => ok(value))(2), ok({ input: 2, value: 2 }));
  if (false) {
    // @ts-expect-error Capturing errors cannot make a number rule accept string input.
    carried('wrong');
    // @ts-expect-error withInput remains synchronous; promises require an effect boundary.
    withInput(async (value: number) => ok(value));
    // @ts-expect-error A non-Result function remains invalid.
    withInput((value: number) => value);
  }
});

test('whole-result capture preserves native generic input/value propagation and opaque identity', () => {
  class Input { readonly amount = 3; #proof = true; proof() { return this.#proof; } }
  const box = <T>(value: T) => ok({ item: value }), identity = <T extends { amount: number }>(value: T) => ok(value);
  const boxed = withInput(box), kept = withInput(identity), input = new Input();
  const result = boxed(input), retained = kept(input); assert(result.ok && retained.ok);
  type Boxed = Assert<Equal<typeof result.value, Readonly<{ input: Input; value: { item: Input } }>>>;
  type Retained = Assert<Equal<typeof retained.value, Readonly<{ input: Input; value: Input }>>>;
  assert.strictEqual(result.value.input, input); assert.strictEqual(result.value.value.item, input); assert.strictEqual(retained.value.value, input);
  assert(input.proof()); assert.equal(Object.isFrozen(input), false); assert(Object.isFrozen(result.value));
});
