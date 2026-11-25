import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { procurementApplication } from './experiments/procurement/projection.js';
import { procurement } from './experiments/procurement/application.js';
import { restoreEntity, placeOrder, registerInvoice, recordPayment, type Actor } from './experiments/procurement/domain.js';
const actor = (role: Actor['role'], groupId = 'g1'): Actor => ({ id: role, role, groupId, active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const lines = [{ sku: 'a', quantity: 2, unitCents: 500 }];
function clients(repository: SqliteProcurement, group = 'g1') {
  return { repository, buyer: procurement(repository, actor('buyer', group), policy), boss: procurement(repository, actor('approver', group), policy), warehouse: procurement(repository, actor('warehouse', group), policy), finance: procurement(repository, actor('finance', group), policy) };
}
async function ordered(f: ReturnType<typeof clients>) {
  assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  assert((await f.boss.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
  assert((await f.buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
}
async function matched(f: ReturnType<typeof clients>) {
  await ordered(f);
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 2 }] })).ok);
  assert((await f.finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 1000 })).ok);
  assert((await f.finance.invoices.match({ id: 'inv', expectedVersion: 1 })).ok);
}
function file() { const directory = mkdtempSync(join(tmpdir(), 'koyuki-procurement-db-')); return { path: join(directory, 'data.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; }
test('SQLite procurement survives reopen and a separate OS reader across all six models', async () => {
  const store = file(); let repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await matched(f);
    assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
    assert((await f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank-1' })).ok);
    repository.close(); repository = new SqliteProcurement(store.path, 'g1');
    for (const kind of ['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const) {
      const entities = repository.list(kind, actor('finance')); assert.equal(entities.length, 1);
      for (const entity of entities) assert.deepEqual(restoreEntity(JSON.parse(JSON.stringify(entity))), entity);
    }
    const child = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { SqliteProcurement } = await import(${JSON.stringify(new URL('./experiments/procurement/sqlite.ts', import.meta.url).href)});
      const db = new SqliteProcurement(${JSON.stringify(store.path)}, 'g1');
      try { console.log(JSON.stringify(db.read('invoice', 'inv', {id:'finance',role:'finance',groupId:'g1',active:true}))); } finally { db.close(); }
    `], { encoding: 'utf8' });
    const persisted = JSON.parse(child); assert.equal(persisted.ok, true); assert.equal(persisted.value.state, 'approved');
    assert((await clients(repository).finance.payments.cancel({ id: 'pay', expectedVersion: 1, reason: 'correction' })).ok);
    assert((await clients(repository).buyer.orders.complete({ id: 'po', expectedVersion: 3 })).ok);
  } finally { repository.close(); store.clean(); }
});
test('SQLite rolls back order, receipt and invoice changes if the final stock write fails', async () => {
  const store = file(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await matched(f);
    const admin = new DatabaseSync(store.path);
    try { admin.exec("CREATE TRIGGER reject_stock BEFORE UPDATE ON procurement WHEN NEW.kind = 'stock' BEGIN SELECT RAISE(ABORT, 'InjectedStockFailure'); END;"); } finally { admin.close(); }
    const before = (['order', 'receipt', 'invoice', 'stock'] as const).map(kind => JSON.stringify(repository.list(kind, actor('warehouse'))));
    await assert.rejects(f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }), /InjectedStockFailure/);
    const after = (['order', 'receipt', 'invoice', 'stock'] as const).map(kind => JSON.stringify(repository.list(kind, actor('warehouse'))));
    assert.deepEqual(after, before);
    const repair = new DatabaseSync(store.path); try { repair.exec('DROP TRIGGER reject_stock'); } finally { repair.close(); }
    assert((await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' })).ok);
    assert.equal(repository.list('invoice', actor('finance'))[0]?.state, 'registered');
  } finally { repository.close(); store.clean(); }
});
test('two SQLite connections serialize inventory CAS and protect reservations against returns', async () => {
  const store = file(), first = new SqliteProcurement(store.path, 'g1'), second = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(first), g = clients(second); await matched(f);
    const input = { id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 2 };
    const results = await Promise.all([f.warehouse.inventory.reserve(input), g.warehouse.inventory.reserve(input)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok), { ok: false, error: { kind: 'Conflict' } });
    assert.deepEqual(await g.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }), { ok: false, error: { kind: 'InsufficientStock' } });
    assert.equal(second.list('stock', actor('warehouse'))[0]?.positions[0]?.reserved, 2);
    assert.equal(first.list('invoice', actor('finance'))[0]?.state, 'matched');
  } finally { first.close(); second.close(); store.clean(); }
});
test('corrupt persisted state is a defect, not a valid proof or an expected business rejection', async () => {
  const store = file(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await ordered(f);
    const admin = new DatabaseSync(store.path);
    try { admin.exec("UPDATE procurement SET payload = json_remove(payload, '$.approvedBy') WHERE kind = 'request'"); } finally { admin.close(); }
    assert.throws(() => repository.read('request', 'rq', actor('buyer')), /CorruptProcurementStorage/);
    assert.throws(() => repository.list('request', actor('buyer')), /CorruptProcurementStorage/);
    await assert.rejects(f.buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'second', supplier: 'supplier' }), /CorruptProcurementStorage/);
    assert.equal(repository.list('order', actor('buyer')).length, 1);
  } finally { repository.close(); store.clean(); }
});
test('SQLite binds trusted groups and keeps same business IDs isolated', async () => {
  const store = file(), first = new SqliteProcurement(store.path, 'g1'), second = new SqliteProcurement(store.path, 'g2');
  try {
    await ordered(clients(first)); await ordered(clients(second, 'g2'));
    assert.deepEqual(first.read('request', 'rq', actor('buyer', 'g2')), { ok: false, error: { kind: 'NotFound' } });
    assert.equal(first.list('request', actor('buyer', 'g2')).length, 0);
    const foreign = second.read('request', 'rq', actor('buyer', 'g2')); assert(foreign.ok);
    assert.deepEqual(await first.commit({ result: foreign.value, writes: [foreign.value], checks: [] }, actor('buyer', 'g2')), { ok: false, error: { kind: 'Conflict' } });
    assert.equal(first.list('request', actor('buyer')).length, 1);
    assert.equal(second.list('request', actor('buyer', 'g2')).length, 1);
  } finally { first.close(); second.close(); store.clean(); }
});

test('storage decoding accepts all sixteen state shapes and rejects corrupt fields and impossible payloads', () => {
  const base = { id: 'entity', groupId: 'g1', version: 1 };
  const request = { ...base, kind: 'request', ownerId: 'buyer', lines, totalCents: 1000 };
  const invoice = { ...base, kind: 'invoice', orderId: 'order', amountCents: 1000 };
  const receipt = { ...base, kind: 'receipt', orderId: 'order', quantities: [{ sku: 'a', quantity: 2 }] };
  const payment = { ...base, kind: 'payment', invoiceId: 'invoice', amountCents: 1000, reference: 'bank-1', recordedBy: 'finance' };
  const stock = { ...base, id: 'warehouse', kind: 'stock', positions: [{ sku: 'a', location: 'receiving', onHand: 2, reserved: 1 }], lastAdjustment: { reason: 'count', by: 'warehouse' } };
  const valid = [
    { ...request, state: 'draft' }, { ...request, state: 'submitted', approverId: 'approver' },
    { ...request, state: 'approved', approverId: 'approver', approvedBy: 'approver' }, { ...request, state: 'rejected', reason: 'duplicate', rejectedBy: 'approver' },
    ...['placed', 'cancelled', 'completed'].map(state => ({ ...base, kind: 'order', state, requestId: 'request', ownerId: 'buyer', supplier: 'supplier', lines, totalCents: 1000 })),
    { ...receipt, state: 'accepted' }, { ...receipt, state: 'returned', reason: 'defect', returnedBy: 'warehouse' },
    { ...invoice, state: 'registered' }, { ...invoice, state: 'matched', receiptIds: ['receipt'] },
    { ...invoice, state: 'approved', receiptIds: ['receipt'], approvedBy: 'finance' }, { ...invoice, state: 'voided', reason: 'duplicate', voidedBy: 'finance' },
    { ...payment, state: 'recorded' }, { ...payment, state: 'cancelled', reason: 'wrong reference', cancelledBy: 'finance' }, stock,
  ];
  assert.equal(valid.length, 16);
  for (const entity of valid) {
    assert.deepEqual(restoreEntity(JSON.parse(JSON.stringify(entity))), entity);
    assert.equal(restoreEntity({ ...entity, version: 0 }), null);
    assert.equal(restoreEntity({ ...entity, unexpected: 'field' }), null);
    assert.equal(restoreEntity({ ...entity, groupId: '' }), null);
  }
  for (const entity of [
    { ...request, state: 'approved', approverId: 'approver' },
    { ...request, state: 'approved', approverId: 'buyer', approvedBy: 'buyer' },
    { ...request, state: 'draft', totalCents: 999 },
    { ...request, state: 'draft', lines: [{ ...lines[0], unexpected: true }] },
    { ...invoice, state: 'registered', receiptIds: ['receipt'] },
    { ...invoice, state: 'matched', receiptIds: ['receipt', 'receipt'] },
    { ...invoice, state: 'matched', receiptIds: new Array(1) },
    { ...receipt, state: 'accepted', quantities: [{ sku: 'a', quantity: -1 }] },
    { ...stock, positions: [{ sku: 'a', location: 'receiving', onHand: 1, reserved: 2 }] },
    { ...stock, positions: [...stock.positions, ...stock.positions] },
    { ...stock, lastAdjustment: { reason: ' ', by: 'warehouse' } },
    { ...payment, state: 'recorded', amountCents: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(restoreEntity(entity), null);
});

test('SQLite unique indexes reject stale absence facts even when the conflicting row was not a declared check', async () => {
  const store = file(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await matched(f);
    const request = repository.read('request', 'rq', actor('buyer')); assert(request.ok);
    const duplicateOrder = placeOrder({ input: { id: 'rq', expectedVersion: 3, orderId: 'second', supplier: 'supplier' }, actor: actor('buyer'), current: request.value, alreadyOrdered: false }); assert(duplicateOrder.ok);
    assert.deepEqual(await repository.commit(duplicateOrder.value, actor('buyer')), { ok: false, error: { kind: 'Conflict' } });
    assert.equal(repository.list('order', actor('buyer')).length, 1);
    const order = repository.read('order', 'po', actor('finance')); assert(order.ok);
    const duplicateInvoice = registerInvoice({ input: { id: 'po', expectedVersion: 3, invoiceId: 'second', amountCents: 1000 }, actor: actor('finance'), current: order.value, alreadyInvoiced: false }); assert(duplicateInvoice.ok);
    assert.deepEqual(await repository.commit(duplicateInvoice.value, actor('finance')), { ok: false, error: { kind: 'Conflict' } });
    const unchangedOrder = repository.read('order', 'po', actor('buyer')); assert(unchangedOrder.ok); assert.equal(unchangedOrder.value.version, 3);
    assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
    assert((await f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank-1' })).ok);
    const invoice = repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok);
    const duplicatePayment = recordPayment({ input: { id: 'inv', expectedVersion: 3, paymentId: 'second', reference: 'bank-2' }, actor: actor('finance'), current: invoice.value, alreadyRecorded: false }); assert(duplicatePayment.ok);
    assert.deepEqual(await repository.commit(duplicatePayment.value, actor('finance')), { ok: false, error: { kind: 'Conflict' } });
    assert((await f.finance.payments.cancel({ id: 'pay', expectedVersion: 1, reason: 'correction' })).ok);
    const reusedReference = recordPayment({ input: { id: 'inv', expectedVersion: 3, paymentId: 'third', reference: 'bank-1' }, actor: actor('finance'), current: invoice.value, alreadyRecorded: false }); assert(reusedReference.ok);
    assert.deepEqual(await repository.commit(reusedReference.value, actor('finance')), { ok: false, error: { kind: 'Conflict' } });
    assert.equal(repository.list('payment', actor('finance')).length, 1);
  } finally { repository.close(); store.clean(); }
});
test('an unrelated corrupt row is not read during a point-checked save, while a checked corrupt row is rejected', async () => {
  const store = file(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await ordered(f);
    const admin = new DatabaseSync(store.path);
    try {
      const payload = { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1, positions: [{ sku: 'a', location: 'receiving', onHand: 0, reserved: 5 }], lastAdjustment: null };
      admin.prepare('INSERT INTO procurement(group_id,kind,id,version,payload) VALUES(?,?,?,?,?)').run('g1', 'stock', 'warehouse', 1, JSON.stringify(payload));
    } finally { admin.close(); }
    assert((await f.buyer.requests.create({ id: 'independent', lines })).ok);
    assert.throws(() => repository.read('stock', 'warehouse', actor('warehouse')), /CorruptProcurementStorage/);
    const request = repository.read('request', 'independent', actor('buyer')); assert(request.ok);
    await assert.rejects(repository.commit({ result: { ...request.value, version: 2 }, writes: [{ ...request.value, version: 2 }], checks: [
      { kind: 'request', id: 'independent', groupId: 'g1', version: 1 },
      { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1 },
    ] }, actor('buyer')), /CorruptProcurementStorage/);
    const persisted = repository.read('request', 'independent', actor('buyer')); assert(persisted.ok); assert.equal(persisted.value.version, 1);
  } finally { repository.close(); store.clean(); }
});

test('related SQLite reads isolate parents and groups and keep unrelated corrupt models out of operation loads', async () => {
  const store = file(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await matched(f);
    const admin = new DatabaseSync(store.path);
    try {
      const insert = admin.prepare('INSERT INTO procurement(group_id,kind,id,version,payload) VALUES(?,?,?,?,?)');
      for (const entity of [
        { kind: 'order', id: 'bad-order', groupId: 'g1', version: 1, state: 'placed', requestId: 'other-request' },
        { kind: 'receipt', id: 'bad-receipt', groupId: 'g1', version: 1, state: 'accepted', orderId: 'other-order', quantities: [{ sku: 'a', quantity: -1 }] },
        { kind: 'invoice', id: 'bad-invoice', groupId: 'g1', version: 1, state: 'registered', orderId: 'other-order', amountCents: -1 },
        { kind: 'payment', id: 'bad-payment', groupId: 'g1', version: 1, state: 'recorded', invoiceId: 'other-invoice', reference: 'other-bank', amountCents: -1 },
      ]) insert.run(entity.groupId, entity.kind, entity.id, entity.version, JSON.stringify(entity));
    } finally { admin.close(); }
    for (const kind of ['order', 'receipt', 'invoice', 'payment'] as const) {
      assert.throws(() => repository.list(kind, actor('finance')), /CorruptProcurementStorage/);
      assert.deepEqual(repository.related(kind, "' OR 1=1 --", actor('finance')), []);
      assert.deepEqual(repository.related(kind, 'po', actor('finance', 'foreign')), []);
    }
    assert.equal(repository.related('receipt', 'po', actor('warehouse')).length, 1);
    assert.equal(repository.related('invoice', 'po', actor('finance')).length, 1);
    assert.throws(() => repository.related('receipt', 'other-order', actor('warehouse')), /CorruptProcurementStorage/);
    // Every relation-based loader runs without reading corrupt rows owned by other parents.
    assert((await f.buyer.requests.create({ id: 'rq2', lines })).ok);
    assert((await f.buyer.requests.submit({ id: 'rq2', expectedVersion: 1, approverId: 'approver' })).ok);
    assert((await f.boss.requests.approve({ id: 'rq2', expectedVersion: 2 })).ok);
    assert((await f.buyer.orders.place({ id: 'rq2', expectedVersion: 3, orderId: 'po2', supplier: 'supplier' })).ok);
    assert((await f.warehouse.receipts.receive({ id: 'po2', expectedVersion: 1, receiptId: 'rc2', quantities: [{ sku: 'a', quantity: 2 }] })).ok);
    assert((await f.finance.invoices.register({ id: 'po2', expectedVersion: 2, invoiceId: 'inv2', amountCents: 1000 })).ok);
    assert((await f.finance.invoices.match({ id: 'inv2', expectedVersion: 1 })).ok);
    assert((await f.finance.invoices.approve({ id: 'inv2', expectedVersion: 2 })).ok);
    assert((await f.finance.payments.record({ id: 'inv2', expectedVersion: 3, paymentId: 'pay2', reference: 'bank-2' })).ok);
    assert((await f.buyer.orders.complete({ id: 'po2', expectedVersion: 3 })).ok);
  } finally { repository.close(); store.clean(); }
});

test('SQLite-backed Application preserves projection after rollback and applies all models after a successful retry', async () => {
  const store = file(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const f = clients(repository); await matched(f);
    const seed = (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor('warehouse')));
    const session = await procurementApplication(repository, actor('warehouse'), policy, seed).start();
    const admin = new DatabaseSync(store.path);
    try { admin.exec("CREATE TRIGGER projection_failure BEFORE UPDATE ON procurement WHEN NEW.kind = 'stock' BEGIN SELECT RAISE(ABORT, 'InjectedStockFailure'); END;"); } finally { admin.close(); }
    await session.dispatch({ type: 'receipt.return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } });
    assert.equal(session.snapshot().state.kind, 'crashed'); assert.deepEqual(session.snapshot().view.entities, seed);
    const repair = new DatabaseSync(store.path); try { repair.exec('DROP TRIGGER projection_failure'); } finally { repair.close(); }
    await session.dispatch({ type: 'dismiss' });
    await session.dispatch({ type: 'receipt.return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } });
    assert.equal(session.snapshot().state.kind, 'ready');
    const persisted = (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor('warehouse')));
    assert.deepEqual(session.snapshot().view.entities, persisted);
  } finally { repository.close(); store.clean(); }
});
