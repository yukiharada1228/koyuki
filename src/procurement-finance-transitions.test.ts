import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err } from './framework/index.js';
import { checkInvoiceRegistration, registerCheckedInvoice, checkInvoiceMatching, matchCheckedInvoice,
  checkPaymentRecording, recordCheckedPayment, checkPaymentCancellation, cancelCheckedPayment,
  checkInvoice, createRequest, type Actor, type Invoice, type Order, type Payment, type Receipt, type Change, type Entity } from './experiments/procurement/domain.js';
const actor: Actor = { id: 'finance', groupId: 'g', role: 'finance', active: true };
const buyer: Actor = { ...actor, id: 'buyer', role: 'buyer' };
const created = createRequest({ actor: buyer, input: { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 100 }] } });
assert(created.ok);
const order: Order = { kind: 'order', state: 'placed', id: 'po', groupId: 'g', version: 1, requestId: 'rq', ownerId: 'buyer', supplier: 'supplier', lines: created.value.result.lines, totalCents: 100 };
const invoice: Invoice = { kind: 'invoice', state: 'registered', id: 'iv', groupId: 'g', version: 1, orderId: 'po', amountCents: 100 };
const receipt: Receipt = { kind: 'receipt', state: 'accepted', id: 'rc', groupId: 'g', version: 1, orderId: 'po', quantities: [{ sku: 'a', quantity: 1 }] };
const approved: Invoice = { ...invoice, state: 'approved', receiptIds: ['rc'], approvedBy: 'approver' };
const payment: Payment = { kind: 'payment', state: 'recorded', id: 'pay', groupId: 'g', version: 1, invoiceId: 'iv', amountCents: 100, reference: 'bank', recordedBy: 'finance' };
const registration = { input: { id: 'po', expectedVersion: 1, invoiceId: 'iv', amountCents: 100 }, actor, current: order, alreadyInvoiced: false as const };
const matching = { input: { id: 'iv', expectedVersion: 1 }, actor, current: invoice, order, receipts: [receipt] };
const recording = { input: { id: 'iv', expectedVersion: 1, paymentId: 'pay', reference: 'bank' }, actor, current: approved, alreadyRecorded: false as const };
const cancellation = { input: { id: 'pay', expectedVersion: 1, reason: ' duplicate ' }, actor, current: payment };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

test('finance validation keeps context identity, precise initial states and operation-specific proofs', () => {
  class Extra { #token = 'private'; token() { return this.#token; } }
  const extra = new Extra(), source = { ...registration, extra }, before = structuredClone(registration);
  const registered = checkInvoiceRegistration(source), matched = checkInvoiceMatching(matching), recorded = checkPaymentRecording(recording), cancelled = checkPaymentCancellation(cancellation);
  assert(registered.ok && matched.ok && recorded.ok && cancelled.ok);
  assert.strictEqual(registered.value, source); assert.strictEqual(registered.value.extra, extra); assert.equal(registered.value.extra.token(), 'private');
  assert.strictEqual(matched.value, matching); assert.strictEqual(recorded.value, recording); assert.strictEqual(cancelled.value, cancellation);
  type RegisterState = Assert<Equal<typeof registered.value.current.state, 'placed'>>;
  type MatchState = Assert<Equal<typeof matched.value.current.state, 'registered'>>;
  type RecordState = Assert<Equal<typeof recorded.value.current.state, 'approved'>>;
  type CancelState = Assert<Equal<typeof cancelled.value.current.state, 'recorded'>>;
  type NotInvoiced = Assert<Equal<typeof registered.value.alreadyInvoiced, false>>;
  type NotRecorded = Assert<Equal<typeof recorded.value.alreadyRecorded, false>>;
  assert.deepEqual(registration, before);
});

test('finance transitions produce independent expected plans after validation', () => {
  const registered = checkInvoiceRegistration(registration), matched = checkInvoiceMatching(matching), recorded = checkPaymentRecording(recording), cancelled = checkPaymentCancellation(cancellation);
  assert(registered.ok && matched.ok && recorded.ok && cancelled.ok);
  const versionCheck = (kind: 'order' | 'invoice' | 'payment', id: string) => ({ kind, id, groupId: 'g', version: 1 });
  assert.deepEqual(registerCheckedInvoice(registered.value), ok({ result: invoice, writes: [{ ...order, version: 2 }, invoice],
    checks: [versionCheck('order', 'po'), { kind: 'invoice', id: 'iv', groupId: 'g', version: null }] }));
  const matchedInvoice = { ...invoice, state: 'matched', receiptIds: ['rc'], version: 2 };
  assert.deepEqual(matchCheckedInvoice(matched.value), ok({ result: matchedInvoice, writes: [matchedInvoice], checks: [versionCheck('invoice', 'iv'), versionCheck('order', 'po')] }));
  assert.deepEqual(recordCheckedPayment(recorded.value), ok({ result: payment, writes: [payment], checks: [versionCheck('invoice', 'iv'), { kind: 'payment', id: 'pay', groupId: 'g', version: null }] }));
  const cancelledPayment = { ...payment, state: 'cancelled', reason: 'duplicate', cancelledBy: 'finance', version: 2 };
  assert.deepEqual(cancelCheckedPayment(cancelled.value), ok({ result: cancelledPayment, writes: [cancelledPayment], checks: [versionCheck('payment', 'pay')] }));
  assert.equal(cancellation.input.reason, ' duplicate ');
});

test('finance validation preserves original refusal priority with simultaneous faults', () => {
  const inactive = { ...actor, active: false }, invalidVersion = { ...registration, input: { ...registration.input, expectedVersion: 0 } };
  assert.deepEqual(checkInvoiceRegistration({ ...invalidVersion, actor: inactive, input: { ...invalidVersion.input, id: 'other' } }), err({ kind: 'Denied' }));
  assert.deepEqual(checkInvoiceRegistration({ ...invalidVersion, input: { ...invalidVersion.input, id: 'other' } }), err({ kind: 'TargetMismatch' }));
  assert.deepEqual(checkInvoiceRegistration({ ...invalidVersion, current: { ...order, state: 'cancelled' } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(checkInvoiceRegistration({ ...registration, current: { ...order, state: 'cancelled', version: 2 } }), err({ kind: 'Conflict' }));
  assert.deepEqual(checkInvoiceRegistration({ ...registration, current: { ...order, state: 'cancelled' }, input: { ...registration.input, invoiceId: ' ' } }), err({ kind: 'WrongState' }));
  assert.deepEqual(checkInvoiceRegistration({ ...registration, alreadyInvoiced: true, input: { ...registration.input, invoiceId: ' ' } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(checkInvoiceRegistration({ ...registration, alreadyInvoiced: true }), err({ kind: 'AlreadyExists' }));
  // Matching checks current state before related facts, unlike checkInvoice.
  assert.deepEqual(checkInvoiceMatching({ ...matching, current: approved, order: { ...order, id: 'other' } }), err({ kind: 'WrongState' }));
  assert.deepEqual(checkInvoiceMatching({ ...matching, order: { ...order, id: 'other', totalCents: 101 } }), err({ kind: 'TargetMismatch' }));
  assert.deepEqual(checkInvoiceMatching({ ...matching, order: { ...order, totalCents: 101 } }), err({ kind: 'InvoiceMismatch' }));
  assert.deepEqual(checkPaymentRecording({ ...recording, current: invoice, input: { ...recording.input, reference: ' ' } }), err({ kind: 'WrongState' }));
  assert.deepEqual(checkPaymentRecording({ ...recording, alreadyRecorded: true, input: { ...recording.input, reference: ' ' } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(checkPaymentRecording({ ...recording, alreadyRecorded: true }), err({ kind: 'AlreadyExists' }));
  assert.deepEqual(checkPaymentCancellation({ ...cancellation, current: { ...payment, state: 'cancelled', reason: 'old', cancelledBy: 'old' }, input: { ...cancellation.input, reason: ' ' } }), err({ kind: 'WrongState' }));
  assert.deepEqual(checkPaymentCancellation({ ...cancellation, input: { ...cancellation.input, reason: ' ' } }), err({ kind: 'InvalidInput' }));
});

const unchanged = <T>(value: T) => ({ ...value, actor: { ...actor, active: false } });
for (const name of ['register', 'match', 'record', 'cancel'] as const) test(`finance ${name} delegates validation, transition and non-saving failure`, async () => {
  let saves = 0;
  const save = async <T extends Entity>(change: Change<T>) => { saves++; return ok(change.result); };
  const apps = {
    register: business({ name: 'register', load: async (valid: boolean) => ok(valid ? registration : unchanged(registration)), save, operations: { run: [checkInvoiceRegistration, registerCheckedInvoice] } }),
    match: business({ name: 'match', load: async (valid: boolean) => ok(valid ? matching : unchanged(matching)), save, operations: { run: [checkInvoiceMatching, matchCheckedInvoice] } }),
    record: business({ name: 'record', load: async (valid: boolean) => ok(valid ? recording : unchanged(recording)), save, operations: { run: [checkPaymentRecording, recordCheckedPayment] } }),
    cancel: business({ name: 'cancel', load: async (valid: boolean) => ok(valid ? cancellation : unchanged(cancellation)), save, operations: { run: [checkPaymentCancellation, cancelCheckedPayment] } }),
  };
  const app = apps[name], success = await app.run.runDetailed(true);
  assert(success.result.ok); assert.equal(saves, 1);
  assert.deepEqual(success.trace.map(row => [row.step, row.status]), [[`${name}.run:load`, 'ok'], ['run:1', 'ok'], ['run:2', 'ok'], [`${name}.run`, 'ok']]);
  const failed = await app.run.runDetailed(false);
  assert.deepEqual(failed.result, err({ kind: 'Denied' })); assert.equal(saves, 1); assert.equal(failed.plan, null);
  assert.deepEqual(failed.trace.map(row => [row.step, row.status]), [[`${name}.run:load`, 'ok'], ['run:1', 'error']]);
});

function omittedValidationOrMixedProofs() {
  // @ts-expect-error Registration requires its validation proof, not just an order.
  registerCheckedInvoice(registration);
  // @ts-expect-error Matching requires its own validation, not just a registered invoice.
  matchCheckedInvoice(matching);
  // @ts-expect-error Recording requires approval/duplicate/reference validation.
  recordCheckedPayment(recording);
  // @ts-expect-error Cancellation requires its own validation proof.
  cancelCheckedPayment(cancellation);
  const common = checkInvoice(matching);
  if (common.ok) {
    // @ts-expect-error A common invoice check does not validate matching and quantities.
    matchCheckedInvoice(common.value);
  }
  const save = async (change: Change<Invoice>) => ok(change.result);
  business({ name: 'missing-registration', load: async () => ok(registration), save, operations: {
    // @ts-expect-error The framework must reject a pipeline omitting registration validation.
    register: [registerCheckedInvoice],
  } });
  business({ name: 'missing-match', load: async () => ok(matching), save, operations: {
    // @ts-expect-error Matching must not omit its operation-specific validation.
    match: [matchCheckedInvoice],
  } });
  const savePayment = async (change: Change<Payment>) => ok(change.result);
  business({ name: 'missing-record', load: async () => ok(recording), save: savePayment, operations: {
    // @ts-expect-error Recording must not omit approval/duplicate/reference validation.
    record: [recordCheckedPayment],
  } });
  business({ name: 'missing-cancel', load: async () => ok(cancellation), save: savePayment, operations: {
    // @ts-expect-error Cancellation must not omit its operation-specific validation.
    cancel: [cancelCheckedPayment],
  } });
}
void omittedValidationOrMixedProofs;
