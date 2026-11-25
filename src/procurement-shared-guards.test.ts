import test from 'node:test';
import assert from 'node:assert/strict';
import { err } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { createRequest, submitRequest, checkBuyerRequest, checkApproverRequest, checkInvoice,
  editRequest, withdrawRequest, rejectRequest, returnRequest, reassignRequest, approveInvoice, voidInvoice,
  editCheckedRequest, withdrawCheckedRequest, rejectCheckedRequest, returnCheckedRequest, reassignCheckedRequest, approveCheckedInvoice, voidCheckedInvoice,
  type Actor, type Request, type Order, type Invoice, type RuleError } from './experiments/procurement/domain.js';
const buyer: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const boss: Actor = { ...buyer, id: 'boss', role: 'approver' };
const finance: Actor = { ...buyer, id: 'finance', role: 'finance' };
const policy = { requestLimitCents: 1000, approverIds: ['boss', 'next'] };
const lines = [{ sku: 'a', quantity: 1, unitCents: 100 }];
function requestContext(pending = true) {
  const created = createRequest({ input: { id: 'rq', lines }, actor: buyer }); assert(created.ok);
  const submitted = submitRequest({ input: { id: 'rq', expectedVersion: 1, approverId: 'boss' }, actor: buyer, current: created.value.result, policy }); assert(submitted.ok);
  const current: Request = pending ? submitted.value.result : created.value.result;
  return { current, actor: pending ? boss : buyer, input: { id: 'rq', expectedVersion: current.version, reason: ' policy ', approverId: 'next', lines }, policy };
}
function invoiceContext() {
  const request = requestContext().current;
  const order: Order = { kind: 'order', id: 'po', groupId: 'g1', state: 'placed', version: 1, requestId: 'rq', ownerId: 'buyer', supplier: 'supplier', lines: request.lines, totalCents: 100 };
  const current: Invoice = { kind: 'invoice', id: 'inv', groupId: 'g1', state: 'registered', version: 1, orderId: 'po', amountCents: 100 };
  return { input: { id: 'inv', expectedVersion: 1, reason: ' wrong ' }, current, order, actor: finance };
}

test('request checks retain error priority including the late assigned-approver check', () => {
  type Context = ReturnType<typeof requestContext>;
  const cases: readonly [(value: Context) => Context, RuleError['kind']][] = [
    [value => ({ ...value, actor: { ...boss, active: false }, input: { ...value.input, id: 'wrong', expectedVersion: 0 } }), 'Denied'],
    [value => ({ ...value, actor: { ...boss, id: 'buyer' } }), 'Denied'],
    [value => ({ ...value, actor: { ...boss, id: 'other' }, input: { ...value.input, id: 'wrong', expectedVersion: 0 } }), 'TargetMismatch'],
    [value => ({ ...value, actor: { ...boss, id: 'other' }, input: { ...value.input, expectedVersion: 0 } }), 'InvalidInput'],
    [value => ({ ...value, actor: { ...boss, id: 'other' }, input: { ...value.input, expectedVersion: 99 } }), 'Conflict'],
    [value => ({ ...value, actor: { ...boss, id: 'other' } }), 'Denied'],
  ];
  for (const [change, kind] of cases) {
    const value = change(requestContext()); value.input.reason = '';
    for (const run of [rejectRequest, returnRequest, reassignRequest]) assert.deepEqual(run(value), err({ kind }));
    assert.deepEqual(checkApproverRequest(value), err({ kind }));
  }
  const owner = requestContext(false); owner.actor = { ...buyer, id: 'stranger' }; owner.input.expectedVersion = 0;
  assert.deepEqual(editRequest(owner), err({ kind: 'Denied' })); assert.deepEqual(withdrawRequest(owner), err({ kind: 'Denied' }));
});

test('role-specific proofs retain context and preserve explicit request changes', () => {
  const value = requestContext(), before = structuredClone(value), checked = checkApproverRequest(value); assert(checked.ok);
  assert.strictEqual(checked.value, value);
  const reassigned = { ...value.current, approverId: 'next', version: 3 };
  assert.deepEqual(reassignCheckedRequest(checked.value), { ok: true, value: { result: reassigned, writes: [reassigned], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 2 }] } });
  const result = { kind: 'request', state: 'rejected', id: 'rq', groupId: 'g1', ownerId: 'buyer', lines: value.current.lines, totalCents: 100, version: 3, rejectedBy: 'boss', reason: 'policy' };
  assert.deepEqual(rejectCheckedRequest(checked.value), { ok: true, value: { result, writes: [result], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 2 }] } });
  assert.deepEqual(value, before);
  const own = requestContext(false), ownerChecked = checkBuyerRequest(own); assert(ownerChecked.ok);
  assert.strictEqual(ownerChecked.value, own); assert(editCheckedRequest(ownerChecked.value).ok);
});

test('invoice checks preserve refusal priority and independently specified composite writes', () => {
  const value = invoiceContext();
  assert.deepEqual(voidInvoice({ ...value, actor: buyer, input: { ...value.input, expectedVersion: 0, reason: '' } }), err({ kind: 'Denied' }));
  assert.deepEqual(approveInvoice({ ...value, order: { ...value.order, id: 'wrong' }, input: { ...value.input, expectedVersion: 0 } }), err({ kind: 'TargetMismatch' }));
  assert.deepEqual(voidInvoice({ ...value, input: { ...value.input, expectedVersion: 0, reason: '' } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(approveInvoice({ ...value, input: { ...value.input, expectedVersion: 99 } }), err({ kind: 'Conflict' }));
  const checked = checkInvoice(value); assert(checked.ok); assert.strictEqual(checked.value, value);
  const result = { ...value.current, state: 'voided', version: 2, reason: 'wrong', voidedBy: 'finance' };
  assert.deepEqual(voidCheckedInvoice(checked.value), { ok: true, value: { result, writes: [{ ...value.order, version: 2 }, result], checks: [{ kind: 'invoice', id: 'inv', groupId: 'g1', version: 1 }, { kind: 'order', id: 'po', groupId: 'g1', version: 1 }] } });
});

for (const backend of ['memory', 'sqlite']) test(`request and invoice check failures stop at the declared boundary: ${backend}`, async () => {
  const repository = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(':memory:', 'g1');
  let commits = 0;
  const tracked: ProcurementRepository = { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: (change, actor) => { commits++; return repository.commit(change, actor); } };
  const owner = procurement(tracked, buyer, policy), approver = procurement(tracked, boss, policy), accounts = procurement(tracked, finance, policy);
  try {
    assert((await owner.requests.create({ id: 'rq', lines })).ok);
    assert((await owner.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'boss' })).ok);
    const denied = await procurement(tracked, { ...boss, id: 'other' }, policy).requests.reject.runDetailed({ id: 'rq', expectedVersion: 2, reason: '' });
    assert.deepEqual(denied.result, err({ kind: 'Denied' })); assert.deepEqual(denied.trace.map(row => row.status), ['ok', 'error']); assert.equal(denied.plan, null);
    const invalid = await approver.requests.reject.runDetailed({ id: 'rq', expectedVersion: 2, reason: '' });
    assert.deepEqual(invalid.result, err({ kind: 'InvalidInput' })); assert.deepEqual(invalid.trace.map(row => row.status), ['ok', 'ok', 'error']); assert.equal(invalid.plan, null); assert.equal(commits, 2);
    assert((await approver.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
    assert((await owner.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
    assert((await accounts.invoices.register({ id: 'po', expectedVersion: 1, invoiceId: 'inv', amountCents: 100 })).ok);
    const badVersion = await accounts.invoices.void.runDetailed({ id: 'inv', expectedVersion: 0, reason: '' });
    assert.deepEqual(badVersion.result, err({ kind: 'InvalidInput' })); assert.deepEqual(badVersion.trace.map(row => row.status), ['ok', 'error']);
    const badReason = await accounts.invoices.void.runDetailed({ id: 'inv', expectedVersion: 1, reason: '' });
    assert.deepEqual(badReason.result, err({ kind: 'InvalidInput' })); assert.deepEqual(badReason.trace.map(row => row.status), ['ok', 'ok', 'error']); assert.equal(commits, 5);
    const saved = await accounts.invoices.void({ id: 'inv', expectedVersion: 1, reason: ' wrong ' }); assert(saved.ok); assert.equal(saved.value.state, 'voided'); assert.equal(commits, 6);
    const order = await repository.read('order', 'po', buyer); assert(order.ok); assert.equal(order.value.version, 3);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts() {
  const value = requestContext(), buyerProof = checkBuyerRequest(value), approverProof = checkApproverRequest(value);
  if (buyerProof.ok) {
    // @ts-expect-error the buyer proof is not an approver proof
    rejectCheckedRequest(buyerProof.value);
    // @ts-expect-error returning a request requires an approver proof
    returnCheckedRequest(buyerProof.value);
    // @ts-expect-error policy data does not turn a buyer proof into an approver proof
    reassignCheckedRequest(buyerProof.value);
  }
  if (approverProof.ok) {
    // @ts-expect-error the approver proof is not a buyer proof
    editCheckedRequest(approverProof.value);
    // @ts-expect-error withdrawal requires a buyer proof
    withdrawCheckedRequest(approverProof.value);
  }
  // @ts-expect-error invoice approval cannot skip shared verification
  approveCheckedInvoice(invoiceContext());
  // @ts-expect-error invoice voiding cannot skip shared verification
  voidCheckedInvoice(invoiceContext());
}
void typeContracts;
