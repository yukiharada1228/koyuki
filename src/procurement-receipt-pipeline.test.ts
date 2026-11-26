import test from 'node:test';
import assert from 'node:assert/strict';
import { business, err, ok } from './framework/index.js';
import { checkReceipt, returnReceipt, correctReceipt, returnCheckedReceipt, correctCheckedReceipt, receiveOrder, receiptCorrectionInput, finishReceiptCorrection, createRequest, type ReceivedChange, type Actor, type Order, type Receipt, type Stock, type Invoice, type Change } from './experiments/procurement/domain.js';
import { receiveDecision, returnDecision, correctDecision } from './experiments/procurement/receipt-pipeline.js';
import { includeReceivedStock, includeChangedStock, receiveIntoStock, returnFromStock, correctInStock, type ReceiveStockContext, type ReceiptStockContext } from './experiments/procurement/inventory.js';
import { procurement } from './experiments/procurement/application.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
const buyer: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const warehouse: Actor = { ...buyer, id: 'warehouse', role: 'warehouse' };
const policy = { requestLimitCents: 1000, approverIds: ['boss'] };
const lines = [{ sku: 'a', quantity: 1, unitCents: 100 }];
function fixture(): ReceiveStockContext {
  const created = createRequest({ input: { id: 'rq', lines }, actor: buyer }); assert(created.ok);
  const current: Order = { kind: 'order', id: 'po', groupId: 'g1', version: 1, state: 'placed', requestId: 'rq', ownerId: 'buyer', supplier: 'supplier', totalCents: 100, lines: created.value.result.lines };
  return { input: { id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] }, actor: warehouse, current, receipts: [], stock: null };
}

function receiptContext() {
  const base = fixture();
  const current: Receipt = { kind: 'receipt', id: 'rc', groupId: 'g1', version: 1, state: 'accepted', orderId: 'po', quantities: [{ sku: 'a', quantity: 1 }] };
  const invoice: Invoice = { kind: 'invoice', id: 'iv', groupId: 'g1', version: 3, orderId: 'po', amountCents: 100, state: 'matched', receiptIds: ['rc'] };
  const stock: Stock = { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1, positions: [{ sku: 'a', location: 'receiving', onHand: 1, reserved: 0 }], lastAdjustment: null };
  return { actor: warehouse, current, order: { ...base.current, version: 2 }, receipts: [current], invoices: [invoice], stock,
    input: { id: 'rc', expectedVersion: 1, reason: ' damaged ', quantities: [{ sku: 'a', quantity: 1 }] } };
}

test('checked receipt decisions preserve stock facts and explicit invoice-reset plans', () => {
  const value = receiptContext(), before = structuredClone(value), checked = checkReceipt(value); assert(checked.ok);
  assert.strictEqual(checked.value, value); assert.strictEqual(checked.value.stock, value.stock);
  const reset: Invoice = { kind: 'invoice', id: 'iv', groupId: 'g1', version: 4, orderId: 'po', amountCents: 100, state: 'registered' };
  const checks = [{ kind: 'receipt', id: 'rc', groupId: 'g1', version: 1 }, { kind: 'order', id: 'po', groupId: 'g1', version: 2 }, { kind: 'invoice', id: 'iv', groupId: 'g1', version: 3 }];
  const returned: Receipt = { ...value.current, state: 'returned', reason: 'damaged', returnedBy: warehouse.id, version: 2 };
  assert.deepEqual(returnCheckedReceipt(checked.value), ok({ result: returned, writes: [{ ...value.order, version: 3 }, returned, reset], checks }));
  const corrected: Receipt = { ...value.current, version: 2 };
  const expectedCorrection = { result: corrected, writes: [{ ...value.order, version: 3 }, corrected, reset], checks };
  assert.deepEqual(correctCheckedReceipt(checked.value), ok(expectedCorrection));
  const declared = correctDecision.inspect(checked.value); assert(declared.result.ok); assert(Object.isFrozen(declared.result.value));
  assert.strictEqual(declared.result.value.input, value); assert.deepEqual(declared.result.value.value, expectedCorrection);
  assert.deepEqual(declared.trace.map(row => row.step), ['revalidate-correction', 'correct-receipt-plan']);
  assert.deepEqual(value, before);
});

test('receipt validation keeps scope, version and state refusal priority before operation-specific input', () => {
  const value = receiptContext();
  for (const run of [returnReceipt, correctReceipt]) {
    const invalid = { ...value, input: { ...value.input, reason: '', quantities: [] } };
    assert.deepEqual(run({ ...invalid, actor: { ...warehouse, active: false }, input: { ...invalid.input, id: 'wrong', expectedVersion: 0 } }), err({ kind: 'Denied' }));
    assert.deepEqual(run({ ...invalid, input: { ...invalid.input, id: 'wrong', expectedVersion: 0 } }), err({ kind: 'TargetMismatch' }));
    const wrongState = { ...invalid, current: { ...value.current, state: 'returned' as const, reason: 'prior', returnedBy: warehouse.id } };
    assert.deepEqual(run({ ...wrongState, input: { ...invalid.input, expectedVersion: 0 } }), err({ kind: 'InvalidInput' }));
    assert.deepEqual(run({ ...wrongState, input: { ...invalid.input, expectedVersion: 99 } }), err({ kind: 'Conflict' }));
    assert.deepEqual(run(wrongState), err({ kind: 'WrongState' }));
    assert.deepEqual(run({ ...invalid, order: { ...value.order, groupId: 'other' } }), err({ kind: 'TargetMismatch' }));
  }
});

test('receipt preparation preserves context and stock composition matches an explicit atomic write plan', () => {
  const value = fixture(), before = structuredClone(value), prepared = receiveDecision(value); assert(prepared.ok);
  assert.strictEqual(prepared.value.input, value); assert(Object.isFrozen(prepared.value));
  const receipt: Receipt = { kind: 'receipt', id: 'rc', groupId: 'g1', version: 1, state: 'accepted', orderId: 'po', quantities: [{ sku: 'a', quantity: 1 }] };
  const stock: Stock = { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1, positions: [{ sku: 'a', location: 'receiving', onHand: 1, reserved: 0 }], lastAdjustment: null };
  const expected = { ok: true, value: { result: receipt, writes: [{ ...value.current, version: 2 }, receipt, stock], checks: [
    { kind: 'order', id: 'po', groupId: 'g1', version: 1 }, { kind: 'receipt', id: 'rc', groupId: 'g1', version: null }, { kind: 'stock', id: 'warehouse', groupId: 'g1', version: null },
  ] } };
  const planBefore = structuredClone(prepared.value.value);
  assert.deepEqual(includeReceivedStock(prepared.value), expected); assert.deepEqual(receiveIntoStock(value), expected);
  assert.deepEqual(prepared.value.value, planBefore); assert.deepEqual(value, before);
});

test('receipt rejection retains priority over invalid stock and stock rejection leaves planned domain values unchanged', () => {
  const base = fixture();
  const stock: Stock = { kind: 'stock', id: 'warehouse', groupId: 'other', version: 1, positions: [], lastAdjustment: null };
  const denied = { ...base, actor: { ...warehouse, active: false }, stock };
  assert.deepEqual(receiveDecision(denied), err({ kind: 'Denied' })); assert.deepEqual(receiveIntoStock(denied), err({ kind: 'Denied' }));
  const prepared = receiveDecision({ ...base, stock }); assert(prepared.ok);
  assert.deepEqual(includeReceivedStock(prepared.value), err({ kind: 'TargetMismatch' }));
  const current = prepared.value.value.result;
  const value: ReceiptStockContext<{ id: string; expectedVersion: number; reason: string }> = {
    input: { id: 'rc', expectedVersion: 1, reason: '' }, actor: warehouse, current, order: { ...base.current, version: 2 }, receipts: [current], invoices: [], stock,
  };
  const checked = checkReceipt(value); assert(checked.ok); assert.strictEqual(checked.value, value);
  assert.deepEqual(returnDecision(checked.value), err({ kind: 'InvalidInput' })); assert.deepEqual(returnFromStock(value), err({ kind: 'InvalidInput' }));
  const correction = { ...value, input: { id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }] } };
  const checkedCorrection = checkReceipt(correction); assert(checkedCorrection.ok);
  assert.deepEqual(correctDecision.run(checkedCorrection.value), err({ kind: 'QuantityExceeded' })); assert.deepEqual(correctInStock(correction), err({ kind: 'QuantityExceeded' }));
  const reserved = { ...value, input: { ...value.input, reason: 'damaged' }, stock: { ...stock, groupId: 'g1', positions: [{ sku: 'a', location: 'receiving', onHand: 1, reserved: 1 }] } };
  const checkedReserved = checkReceipt(reserved); assert(checkedReserved.ok);
  const before = structuredClone(reserved), returned = returnDecision(checkedReserved.value); assert(returned.ok);
  const planBefore = structuredClone(returned.value.value);
  assert.deepEqual(includeChangedStock(returned.value), err({ kind: 'InsufficientStock' }));
  assert.deepEqual(reserved, before); assert.deepEqual(returned.value.value, planBefore);
});

for (const backend of ['memory', 'sqlite']) test(`receipt, stock and order are saved only after both plans succeed: ${backend}`, async () => {
  const repository = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(':memory:', 'g1');
  let commits = 0, saveFailure = false;
  const tracked: ProcurementRepository = { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: (change, actor) => {
    commits++; return saveFailure ? Promise.resolve(err({ kind: 'Conflict' })) : repository.commit(change, actor);
  } };
  const owner = procurement(tracked, buyer, policy), worker = procurement(tracked, warehouse, policy);
  const snapshot = async () => ({ order: await repository.read('order', 'po', buyer), receipt: await repository.read('receipt', 'rc', buyer), stock: await repository.read('stock', 'warehouse', buyer) });
  try {
    assert((await owner.requests.create({ id: 'rq', lines })).ok);
    assert((await owner.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'boss' })).ok);
    assert((await procurement(tracked, { ...buyer, id: 'boss', role: 'approver' }, policy).requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
    assert((await owner.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
    assert((await worker.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] })).ok);
    assert((await worker.inventory.reserve({ id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 1 })).ok);
    const before = await snapshot(); assert.equal(commits, 6);
    const excess = await worker.receipts.correct.runDetailed({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }] });
    assert.deepEqual(excess.result, err({ kind: 'QuantityExceeded' })); assert.equal(excess.plan, null);
    assert.deepEqual(excess.trace.map(row => [row.step, row.status]), [['procurement.receipt.v1.correct:load', 'ok'], ['run:1', 'ok'], ['revalidate-correction', 'error']]);
    assert.equal(commits, 6); assert.deepEqual(await snapshot(), before);
    const invalid = await worker.receipts.return.runDetailed({ id: 'rc', expectedVersion: 1, reason: '' });
    assert.deepEqual(invalid.result, err({ kind: 'InvalidInput' })); assert.deepEqual(invalid.trace.map(row => row.status), ['ok', 'ok', 'error']); assert.equal(invalid.plan, null);
    const blocked = await worker.receipts.return.runDetailed({ id: 'rc', expectedVersion: 1, reason: 'damaged' });
    assert.deepEqual(blocked.result, err({ kind: 'InsufficientStock' })); assert.deepEqual(blocked.trace.map(row => row.status), ['ok', 'ok', 'ok', 'error']); assert.equal(blocked.plan, null);
    assert.equal(commits, 6); assert.deepEqual(await snapshot(), before);
    assert((await worker.inventory.release({ id: 'warehouse', expectedVersion: 2, sku: 'a', location: 'receiving', quantity: 1 })).ok);
    const released = await snapshot(); saveFailure = true;
    const failed = await worker.receipts.return.runDetailed({ id: 'rc', expectedVersion: 1, reason: 'damaged' });
    assert.deepEqual(failed.result, err({ kind: 'Conflict' })); assert.deepEqual(failed.trace.map(row => row.status), ['ok', 'ok', 'ok', 'ok', 'error']); assert(failed.plan);
    assert.deepEqual(await snapshot(), released); saveFailure = false;
    const saved = await worker.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'damaged' }); assert(saved.ok); assert.equal(saved.value.state, 'returned'); assert.equal(commits, 9);
    const final = await snapshot(); assert(final.order.ok && final.receipt.ok && final.stock.ok);
    assert.equal(final.order.value.version, 3); assert.equal(final.receipt.value.version, 2); assert.equal(final.stock.value.version, 4);
    assert.deepEqual(final.stock.value.positions, [{ sku: 'a', location: 'receiving', onHand: 0, reserved: 0 }]);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts() {
  const value = fixture();
  // @ts-expect-error a loaded context is not a successful receipt decision
  includeReceivedStock(value);
  // @ts-expect-error an order write plan cannot be used as a receipt write plan
  includeReceivedStock({ input: value, value: { result: value.current, writes: [], checks: [] } });
  const receipt = receiptContext();
  // @ts-expect-error a loaded receipt has no private validation proof
  returnCheckedReceipt(receipt);
  // @ts-expect-error a public marker cannot fabricate the private proof
  correctCheckedReceipt({ ...receipt, receiptCheck: true });
  const checked = checkReceipt(receipt); if (!checked.ok) return;
  returnDecision(checked.value); correctDecision.run(checked.value);
  const received = receiveOrder(receiptCorrectionInput(checked.value));
  if (received.ok) finishReceiptCorrection(checked.value, received.value);
  const raw: Pick<ReceivedChange, 'result' | 'writes' | 'checks'> = { result: { ...receipt.current, state: 'accepted' }, writes: [], checks: [] };
  // @ts-expect-error an accepted receipt plan does not prove its quantities were validated
  finishReceiptCorrection(checked.value, raw);
  // @ts-expect-error a public marker cannot fabricate the private quantity proof
  finishReceiptCorrection(checked.value, { ...raw, receivedCheck: true });
  const withReasonOnly = checkReceipt({ ...receipt, input: { id: 'rc', expectedVersion: 1, reason: 'reason' } });
  if (withReasonOnly.ok) {
    // @ts-expect-error the generic check does not invent correction quantities
    correctDecision.run(withReasonOnly.value);
  }
  const save = async (change: Change<Receipt>) => ok(change.result), load = async (_input: number) => ok(receipt);
  business({ name: 'valid', load, save, operations: { return: [checkReceipt, returnDecision, includeChangedStock] } });
  business({ name: 'invalid', load, save, operations: {
    // @ts-expect-error checked decision cannot follow a loader without the receipt check
    return: [returnDecision, includeChangedStock],
  } });
}
void typeContracts;
