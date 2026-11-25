import test from 'node:test';
import assert from 'node:assert/strict';
import { procurement, procurementChanges } from './experiments/procurement/application.js';
import { applyCommitted, procurementApplication } from './experiments/procurement/projection.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import type { Actor, Entity } from './experiments/procurement/domain.js';
const actor = (role: Actor['role']): Actor => ({ id: role, role, groupId: 'g1', active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
async function fixture() {
  const repository = new MemoryProcurement();
  const buyer = procurement(repository, actor('buyer'), policy), boss = procurement(repository, actor('approver'), policy);
  const warehouse = procurement(repository, actor('warehouse'), policy), finance = procurement(repository, actor('finance'), policy);
  assert((await buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }] })).ok);
  assert((await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  assert((await boss.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
  assert((await buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
  assert((await warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 2 }] })).ok);
  assert((await finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 1000 })).ok);
  assert((await finance.invoices.match({ id: 'inv', expectedVersion: 1 })).ok);
  const initial = (): readonly Entity[] => (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor('warehouse')));
  return { repository, initial };
}
test('detailed procurement output includes all committed models without changing ordinary output', async () => {
  const f = await fixture();
  const commands = procurementChanges(f.repository, actor('warehouse'), policy);
  const result = await commands.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }); assert(result.ok);
  assert.equal(result.value.result.state, 'returned');
  assert.deepEqual(result.value.writes.map(entity => entity.kind), ['order', 'receipt', 'invoice', 'stock']);
  for (const entity of result.value.writes) {
    const persisted = f.repository.read(entity.kind, entity.id, actor('warehouse')); assert(persisted.ok); assert.deepEqual(entity, persisted.value);
  }
});
test('Application projects receipt, order, invoice and inventory from one completion and exposes lifecycle', async () => {
  const f = await fixture();
  const session = await procurementApplication(f.repository, actor('warehouse'), policy, f.initial()).start();
  const kinds: string[] = [], unsubscribe = session.subscribe(snapshot => kinds.push(snapshot.state.kind));
  try {
    await session.dispatch({ type: 'receipt.return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } });
    const snapshot = session.snapshot(); assert.equal(snapshot.state.kind, 'ready'); assert.equal(snapshot.view.busy, false);
    assert(kinds.includes('running')); assert.equal(kinds.at(-1), 'ready');
    assert.deepEqual(snapshot.view.entities, f.initial());
    const invoice = snapshot.view.entities.find(entity => entity.kind === 'invoice'); assert(invoice?.kind === 'invoice'); assert.equal(invoice.state, 'registered');
    const order = snapshot.view.entities.find(entity => entity.kind === 'order'); assert.equal(order?.version, 4);
    const stock = snapshot.view.entities.find(entity => entity.kind === 'stock'); assert(stock?.kind === 'stock'); assert.equal(stock.positions[0]?.onHand, 0);
  } finally { unsubscribe(); }
});
test('expected failure and adapter defects preserve the previous projection', async () => {
  const f = await fixture(), seed = f.initial();
  const session = await procurementApplication(f.repository, actor('buyer'), policy, seed).start();
  await session.dispatch({ type: 'receipt.return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } });
  assert.equal(session.snapshot().state.kind, 'failed'); assert.equal(session.snapshot().view.error, 'Denied');
  assert.deepEqual(session.snapshot().view.entities, seed);
  const broken: ProcurementRepository = { read: f.repository.read.bind(f.repository), related: f.repository.related.bind(f.repository), commit: async () => { throw new Error('InjectedCommitDefect'); } };
  const crashing = await procurementApplication(broken, actor('warehouse'), policy, seed).start();
  await crashing.dispatch({ type: 'receipt.return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } });
  assert.equal(crashing.snapshot().state.kind, 'crashed'); assert.deepEqual(crashing.snapshot().view.entities, seed);
  assert.deepEqual(f.initial(), seed);
});
test('projection rejects foreign scopes, does not mutate inputs and cannot rewind known versions', async () => {
  const f = await fixture(), seed = f.initial();
  const commands = procurementChanges(f.repository, actor('warehouse'), policy);
  const changed = await commands.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }); assert(changed.ok);
  const before = { groupId: 'g1', entities: seed };
  const after = applyCommitted(before, changed.value);
  const old = seed.find(entity => entity.kind === 'order'); assert(old);
  assert.deepEqual(applyCommitted(after, { result: old, writes: [old] }), after);
  assert.equal(seed.find(entity => entity.kind === 'invoice')?.version, 2);
  assert.throws(() => applyCommitted(before, { result: old, writes: [{ ...old, groupId: 'foreign' }] }), /ProjectionScopeMismatch/);
  assert.throws(() => procurementApplication(f.repository, actor('warehouse'), policy, [{ ...old, groupId: 'foreign' }]), /ProjectionScopeMismatch/);
});
test('all 25 operations keep their grouped declarations and namespaced dispatch inputs', async () => {
  const repository = new MemoryProcurement();
  const commands = procurementChanges(repository, actor('buyer'), policy);
  assert.equal(Object.values(commands).reduce((sum, table) => sum + Object.keys(table).length, 0), 25);
  const session = await procurementApplication(repository, actor('buyer'), policy).start();
  await session.dispatch({ type: 'request.create', input: { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 100 }] } });
  assert.equal(session.snapshot().view.entities[0]?.kind, 'request');
  if (false) {
    // @ts-expect-error namespaces preserve the distinction between model operations
    session.dispatch({ type: 'approve', input: { id: 'rq', expectedVersion: 1 } });
    // @ts-expect-error receiving retains its own required quantities
    session.dispatch({ type: 'receipt.receive', input: { id: 'po', expectedVersion: 1, receiptId: 'rc' } });
  }
});
