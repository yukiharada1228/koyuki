import test from 'node:test';
import assert from 'node:assert/strict';
import { err } from './framework/index.js';
import { createRequest, type Actor, type Order, type Receipt, type Stock } from './experiments/procurement/domain.js';
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
  assert.deepEqual(returnDecision(value), err({ kind: 'InvalidInput' })); assert.deepEqual(returnFromStock(value), err({ kind: 'InvalidInput' }));
  const correction = { ...value, input: { id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }] } };
  assert.deepEqual(correctDecision(correction), err({ kind: 'QuantityExceeded' })); assert.deepEqual(correctInStock(correction), err({ kind: 'QuantityExceeded' }));
  const reserved = { ...value, input: { ...value.input, reason: 'damaged' }, stock: { ...stock, groupId: 'g1', positions: [{ sku: 'a', location: 'receiving', onHand: 1, reserved: 1 }] } };
  const before = structuredClone(reserved), returned = returnDecision(reserved); assert(returned.ok);
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
    const invalid = await worker.receipts.return.runDetailed({ id: 'rc', expectedVersion: 1, reason: '' });
    assert.deepEqual(invalid.result, err({ kind: 'InvalidInput' })); assert.deepEqual(invalid.trace.map(row => row.status), ['ok', 'error']); assert.equal(invalid.plan, null);
    const blocked = await worker.receipts.return.runDetailed({ id: 'rc', expectedVersion: 1, reason: 'damaged' });
    assert.deepEqual(blocked.result, err({ kind: 'InsufficientStock' })); assert.deepEqual(blocked.trace.map(row => row.status), ['ok', 'ok', 'error']); assert.equal(blocked.plan, null);
    assert.equal(commits, 6); assert.deepEqual(await snapshot(), before);
    assert((await worker.inventory.release({ id: 'warehouse', expectedVersion: 2, sku: 'a', location: 'receiving', quantity: 1 })).ok);
    const released = await snapshot(); saveFailure = true;
    const failed = await worker.receipts.return.runDetailed({ id: 'rc', expectedVersion: 1, reason: 'damaged' });
    assert.deepEqual(failed.result, err({ kind: 'Conflict' })); assert.deepEqual(failed.trace.map(row => row.status), ['ok', 'ok', 'ok', 'error']); assert(failed.plan);
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
}
void typeContracts;
