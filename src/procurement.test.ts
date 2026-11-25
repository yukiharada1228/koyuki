import test from 'node:test';
import assert from 'node:assert/strict';
import { procurement } from './experiments/procurement/application.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { receiveOrder, type Actor, type Approved, type Draft, type Request, type RuleError } from './experiments/procurement/domain.js';
import { err, type Result } from './framework/index.js';
const actor = (role: Actor['role'], id: string = role, groupId: string = 'g1'): Actor => ({ role, id, groupId, active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver', 'other-boss'] };
const lines = [{ sku: 'a', quantity: 2, unitCents: 300 }, { sku: 'b', quantity: 1, unitCents: 400 }];
function setup() {
  const repository = new MemoryProcurement();
  const as = (identity: Actor, limits = policy) => procurement(repository, identity, limits);
  return { repository, as, buyer: as(actor('buyer')), boss: as(actor('approver')), warehouse: as(actor('warehouse')), finance: as(actor('finance')) };
}
async function ordered(f: ReturnType<typeof setup>) {
  assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  assert((await f.boss.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
  assert((await f.buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: ' Supplier ' })).ok);
}
test('procurement connects request, approval, order, partial receipts and invoice matching', async () => {
  const f = setup(); await ordered(f);
  const registered = await f.finance.invoices.register({ id: 'po', expectedVersion: 1, invoiceId: 'inv', amountCents: 1000 }); assert(registered.ok);
  const before = f.repository.commits;
  assert.deepEqual(await f.finance.invoices.match({ id: 'inv', expectedVersion: 1 }), err({ kind: 'InvoiceMismatch' }));
  assert.equal(f.repository.commits, before);
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 2, receiptId: 'rc1', quantities: [{ sku: 'a', quantity: 1 }] })).ok);
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 3, receiptId: 'rc2', quantities: [{ sku: 'a', quantity: 1 }, { sku: 'b', quantity: 1 }] })).ok);
  const matched = await f.finance.invoices.match({ id: 'inv', expectedVersion: 1 }); assert(matched.ok);
  assert.equal(matched.value.state, 'matched'); assert.equal(matched.value.version, 2);
  if (matched.value.state === 'matched') assert.deepEqual(matched.value.receiptIds, ['rc1', 'rc2']);
  const request = f.repository.read('request', 'rq', actor('buyer')); assert(request.ok);
  assert.equal(request.value.state, 'approved'); assert.equal(request.value.totalCents, 1000);
  const order = f.repository.read('order', 'po', actor('buyer')); assert(order.ok);
  assert.equal(order.value.version, 4); assert.equal(order.value.supplier, 'Supplier');
  const original = f.repository.read('request', 'rq', actor('buyer')); assert(original.ok);
  assert.deepEqual(lines, [{ sku: 'a', quantity: 2, unitCents: 300 }, { sku: 'b', quantity: 1, unitCents: 400 }]);
});
test('invalid lines, unauthorized actors, foreign groups and per-request cap stop before commit', async () => {
  const f = setup();
  for (const invalid of [[], [lines[0], lines[0]], [{ sku: 'a', quantity: 2, unitCents: Number.MAX_SAFE_INTEGER }]]) {
    assert.deepEqual(await f.buyer.requests.create({ id: 'bad', lines: invalid }), err({ kind: 'InvalidInput' }));
  }
  assert.equal(f.repository.commits, 0);
  const injected = { id: 'rq', lines, ownerId: 'intruder', actor: actor('finance'), groupId: 'foreign' };
  const created = await f.buyer.requests.create(injected); assert(created.ok); assert.equal(created.value.ownerId, 'buyer'); assert.equal(created.value.groupId, 'g1');
  const before = f.repository.commits;
  assert.deepEqual(await f.as(actor('buyer', 'stranger')).requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), err({ kind: 'Denied' }));
  assert.deepEqual(await f.as(actor('buyer', 'buyer', 'foreign')).requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), err({ kind: 'NotFound' }));
  assert.deepEqual(await f.as(actor('buyer'), { ...policy, requestLimitCents: 999 }).requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), err({ kind: 'BudgetExceeded' }));
  assert.deepEqual(await f.boss.requests.approve({ id: 'rq', expectedVersion: 1 }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.buyer.requests.submit({ id: 'rq', expectedVersion: 0, approverId: 'approver' }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await f.as({ ...actor('buyer'), active: false }).requests.create({ id: 'disabled', lines }), err({ kind: 'Denied' }));
  assert.equal(f.repository.commits, before);
});
test('concurrent order creation and approval preserve unique references and expected versions', async () => {
  const f = setup();
  assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  const approvals = await Promise.all([f.boss.requests.approve({ id: 'rq', expectedVersion: 2 }), f.boss.requests.approve({ id: 'rq', expectedVersion: 2 })]);
  assert.equal(approvals.filter(result => result.ok).length, 1); assert.deepEqual(approvals.find(result => !result.ok), err({ kind: 'Conflict' }));
  const orders = await Promise.all(['po1', 'po2'].map(orderId => f.buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId, supplier: 'supplier' })));
  assert.equal(orders.filter(result => result.ok).length, 1); assert.deepEqual(orders.find(result => !result.ok), err({ kind: 'Conflict' }));
  assert.equal(f.repository.list('order', actor('buyer')).length, 1);
});
test('over-receipt and stale composite changes cannot partially change orders or receipts', async () => {
  const f = setup(); await ordered(f);
  const order = f.repository.read('order', 'po', actor('warehouse')); assert(order.ok);
  const stale = receiveOrder({ input: { id: 'po', expectedVersion: 1, receiptId: 'stale', quantities: [{ sku: 'a', quantity: 1 }] }, actor: actor('warehouse'), current: order.value, receipts: [] }); assert(stale.ok);
  assert.deepEqual(await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'too-many', quantities: [{ sku: 'a', quantity: 3 }] }), err({ kind: 'QuantityExceeded' }));
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'winner', quantities: [{ sku: 'a', quantity: 1 }] })).ok);
  assert.deepEqual(await f.repository.commit(stale.value, actor('warehouse')), err({ kind: 'Conflict' }));
  assert.deepEqual(f.repository.list('receipt', actor('warehouse')).map(receipt => receipt.id), ['winner']);
  const current = f.repository.read('order', 'po', actor('warehouse')); assert(current.ok); assert.equal(current.value.version, 2);
});
test('invoice amount mismatch remains a business failure and configuration is snapshotted', async () => {
  const f = setup(), mutablePolicy = { requestLimitCents: 1000, approverIds: ['approver'] };
  const buyer = f.as(actor('buyer'), mutablePolicy); mutablePolicy.requestLimitCents = 1; mutablePolicy.approverIds.length = 0;
  assert((await buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  assert((await f.boss.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
  assert((await buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: lines.map(({ sku, quantity }) => ({ sku, quantity })) })).ok);
  assert((await f.finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 999 })).ok);
  const before = f.repository.commits;
  const report = await f.finance.invoices.match.runDetailed({ id: 'inv', expectedVersion: 1 });
  assert.deepEqual(report.result, err({ kind: 'InvoiceMismatch' })); assert.equal(f.repository.commits, before);
  assert.equal(report.trace.at(-1)?.step, 'run:1');
});
test('concurrent receipts cannot count the same remaining quantity twice', async () => {
  const f = setup(); await ordered(f);
  const results = await Promise.all(['rc-a', 'rc-b'].map(receiptId => f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId, quantities: [{ sku: 'a', quantity: 2 }] })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.find(result => !result.ok), err({ kind: 'Conflict' }));
  assert.equal(f.repository.list('receipt', actor('warehouse')).flatMap(receipt => receipt.quantities).reduce((sum, line) => sum + line.quantity, 0), 2);
});
test('unexpected clone defects cannot commit the first half of a composite change', async () => {
  const f = setup(); await ordered(f);
  const order = f.repository.read('order', 'po', actor('warehouse')); assert(order.ok);
  const change = receiveOrder({ input: { id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] }, actor: actor('warehouse'), current: order.value, receipts: [] }); assert(change.ok);
  // Structural typing permits additional fields; a valid interface is not a cloning guarantee.
  const writes = change.value.writes.map(entity => entity.kind === 'receipt' ? { ...entity, debug: () => 1 } : entity);
  const before = f.repository.commits;
  await assert.rejects(f.repository.commit({ ...change.value, writes }, actor('warehouse')));
  assert.equal(f.repository.commits, before);
  assert.equal(f.repository.list('receipt', actor('warehouse')).length, 0);
  const persisted = f.repository.read('order', 'po', actor('warehouse')); assert(persisted.ok); assert.equal(persisted.value.version, 1);
});
test('the host can supply asynchronous repository reads without changing domain rules', async () => {
  const memory = new MemoryProcurement();
  const repository: ProcurementRepository = {
    read: async (kind, id, identity) => memory.read(kind, id, identity),
    list: async (kind, identity) => memory.list(kind, identity),
    commit: (change, identity) => memory.commit(change, identity),
  };
  const as = (identity: Actor) => procurement(repository, identity, policy);
  await ordered({ repository: memory, as, buyer: as(actor('buyer')), boss: as(actor('approver')), warehouse: as(actor('warehouse')), finance: as(actor('finance')) });
  assert.equal(memory.list('order', actor('buyer')).length, 1);
});
// Common save promises Request, so this API honestly returns its state union, not Approved alone.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const api = setup().boss;
const exact: Equal<Awaited<ReturnType<typeof api.requests.approve>>, Result<Request, RuleError | { readonly kind: 'NotFound' | 'Conflict' }>> = true;
void exact;
if (false) {
  // @ts-expect-error the operation keeps its own required input fields
  api.requests.submit({ id: 'rq', expectedVersion: 1 });
  const draft = null as unknown as Draft;
  // @ts-expect-error changing the discriminator does not mint approval evidence
  const forged: Approved = { ...draft, state: 'approved', approverId: 'boss', approvedBy: 'boss' };
  void forged;
}

test('request revisions, withdrawal and return discard obsolete approval fields before resubmission', async () => {
  const f = setup();
  assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await f.buyer.requests.edit({ id: 'rq', expectedVersion: 1, lines: [{ sku: 'c', quantity: 1, unitCents: 800 }] })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 2, approverId: 'approver' })).ok);
  assert.deepEqual(await f.buyer.requests.edit({ id: 'rq', expectedVersion: 3, lines }), err({ kind: 'WrongState' }));
  const withdrawn = await f.buyer.requests.withdraw({ id: 'rq', expectedVersion: 3 }); assert(withdrawn.ok);
  assert.equal(withdrawn.value.state, 'draft'); assert.equal('approverId' in withdrawn.value, false);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 4, approverId: 'approver' })).ok);
  const returned = await f.boss.requests.return({ id: 'rq', expectedVersion: 5 }); assert(returned.ok);
  assert.equal('approverId' in returned.value, false);
  assert((await f.buyer.requests.edit({ id: 'rq', expectedVersion: 6, lines })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 7, approverId: 'approver' })).ok);
  assert((await f.boss.requests.approve({ id: 'rq', expectedVersion: 8 })).ok);
  const before = f.repository.commits;
  assert.deepEqual(await f.buyer.requests.withdraw({ id: 'rq', expectedVersion: 9 }), err({ kind: 'WrongState' }));
  assert.equal(f.repository.commits, before);
});
test('only the current assignee can reassign or reject and rejection is terminal', async () => {
  const f = setup(), other = f.as(actor('approver', 'other-boss'));
  assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  assert.deepEqual(await other.requests.reassign({ id: 'rq', expectedVersion: 2, approverId: 'approver' }), err({ kind: 'Denied' }));
  for (const approverId of ['buyer', 'unknown', 'approver']) assert.deepEqual(await f.boss.requests.reassign({ id: 'rq', expectedVersion: 2, approverId }), err({ kind: 'InvalidInput' }));
  assert((await f.boss.requests.reassign({ id: 'rq', expectedVersion: 2, approverId: 'other-boss' })).ok);
  assert.deepEqual(await f.boss.requests.reject({ id: 'rq', expectedVersion: 3, reason: 'no' }), err({ kind: 'Denied' }));
  assert.deepEqual(await other.requests.reject({ id: 'rq', expectedVersion: 3, reason: '  ' }), err({ kind: 'InvalidInput' }));
  const rejected = await other.requests.reject({ id: 'rq', expectedVersion: 3, reason: '  Duplicate purchase  ' }); assert(rejected.ok);
  assert.equal(rejected.value.state, 'rejected');
  if (rejected.value.state === 'rejected') assert.equal(rejected.value.reason, 'Duplicate purchase');
  assert.equal('approverId' in rejected.value, false); assert.equal('approvedBy' in rejected.value, false);
  const before = f.repository.commits;
  assert.deepEqual(await f.buyer.requests.edit({ id: 'rq', expectedVersion: 4, lines }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.buyer.requests.submit({ id: 'rq', expectedVersion: 4, approverId: 'approver' }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.buyer.orders.place({ id: 'rq', expectedVersion: 4, orderId: 'po', supplier: 'supplier' }), err({ kind: 'WrongState' }));
  assert.equal(f.repository.commits, before);
});
test('withdrawal racing approval permits only one transition from the submitted version', async () => {
  const f = setup();
  assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  const outcomes = await Promise.all([f.buyer.requests.withdraw({ id: 'rq', expectedVersion: 2 }), f.boss.requests.approve({ id: 'rq', expectedVersion: 2 })]);
  assert.equal(outcomes.filter(result => result.ok).length, 1);
  assert.deepEqual(outcomes.find(result => !result.ok), err({ kind: 'Conflict' }));
  assert.equal(f.repository.commits, 3);
});
test('new request operations enforce ownership, active actors, scope, versions and validated replacement lines', async () => {
  const f = setup(); assert((await f.buyer.requests.create({ id: 'rq', lines })).ok);
  assert.deepEqual(await f.as(actor('buyer', 'stranger')).requests.edit({ id: 'rq', expectedVersion: 1, lines }), err({ kind: 'Denied' }));
  assert.deepEqual(await f.buyer.requests.edit({ id: 'rq', expectedVersion: 1, lines: [] }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await f.buyer.requests.edit({ id: 'rq', expectedVersion: 0, lines }), err({ kind: 'InvalidInput' }));
  assert((await f.buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  const before = f.repository.commits;
  assert.deepEqual(await f.buyer.requests.withdraw({ id: 'rq', expectedVersion: 1 }), err({ kind: 'Conflict' }));
  assert.deepEqual(await f.as({ ...actor('approver'), active: false }).requests.return({ id: 'rq', expectedVersion: 2 }), err({ kind: 'Denied' }));
  assert.deepEqual(await f.as(actor('approver', 'approver', 'foreign')).requests.reject({ id: 'rq', expectedVersion: 2, reason: 'no' }), err({ kind: 'NotFound' }));
  assert.equal(f.repository.commits, before);
});

test('supplier amendment preserves approved amounts; cancellation frees the request for a replacement order', async () => {
  const f = setup(); await ordered(f);
  const amended = await f.buyer.orders.amend({ id: 'po', expectedVersion: 1, supplier: ' New supplier ' }); assert(amended.ok);
  assert.equal(amended.value.supplier, 'New supplier'); assert.equal(amended.value.totalCents, 1000);
  assert.deepEqual(await f.as(actor('buyer', 'stranger')).orders.cancel({ id: 'po', expectedVersion: 2 }), err({ kind: 'Denied' }));
  assert((await f.buyer.orders.cancel({ id: 'po', expectedVersion: 2 })).ok);
  assert.deepEqual(await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 3, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.finance.invoices.register({ id: 'po', expectedVersion: 3, invoiceId: 'inv', amountCents: 1000 }), err({ kind: 'WrongState' }));
  const replacements = await Promise.all(['new1', 'new2'].map(orderId => f.buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId, supplier: 'replacement' })));
  assert.equal(replacements.filter(result => result.ok).length, 1);
  assert.equal(f.repository.list('order', actor('buyer')).filter(order => order.state !== 'cancelled').length, 1);
});
test('receipt or invoice creation prevents later amendment and cancellation', async () => {
  for (const downstream of ['receipt', 'invoice']) {
    const f = setup(); await ordered(f);
    if (downstream === 'receipt') assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] })).ok);
    else assert((await f.finance.invoices.register({ id: 'po', expectedVersion: 1, invoiceId: 'inv', amountCents: 1000 })).ok);
    const before = f.repository.commits;
    assert.deepEqual(await f.buyer.orders.cancel({ id: 'po', expectedVersion: 2 }), err({ kind: 'WrongState' }));
    assert.deepEqual(await f.buyer.orders.amend({ id: 'po', expectedVersion: 2, supplier: 'changed' }), err({ kind: 'WrongState' }));
    assert.equal(f.repository.commits, before);
  }
});
test('cancellation racing downstream creation never leaves a cancelled order with a receipt or invoice', async () => {
  for (const downstream of ['receipt', 'invoice']) for (const cancelFirst of [true, false]) {
    const f = setup(); await ordered(f);
    const cancel = () => f.buyer.orders.cancel({ id: 'po', expectedVersion: 1 });
    const create = () => downstream === 'receipt'
      ? f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] })
      : f.finance.invoices.register({ id: 'po', expectedVersion: 1, invoiceId: 'inv', amountCents: 1000 });
    const results = await Promise.all(cancelFirst ? [cancel(), create()] : [create(), cancel()]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok), err({ kind: 'Conflict' }));
    const order = f.repository.read('order', 'po', actor('buyer')); assert(order.ok);
    if (order.value.state === 'cancelled') {
      assert.equal(f.repository.list('receipt', actor('buyer')).length, 0);
      assert.equal(f.repository.list('invoice', actor('buyer')).length, 0);
    }
  }
});
test('order completion requires full receipts and a matched invoice and closes further receiving', async () => {
  const f = setup(); await ordered(f);
  assert.deepEqual(await f.buyer.orders.complete({ id: 'po', expectedVersion: 1 }), err({ kind: 'InvoiceMismatch' }));
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: lines.map(({ sku, quantity }) => ({ sku, quantity })) })).ok);
  assert((await f.finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 1000 })).ok);
  assert.deepEqual(await f.buyer.orders.complete({ id: 'po', expectedVersion: 3 }), err({ kind: 'InvoiceMismatch' }));
  assert((await f.finance.invoices.match({ id: 'inv', expectedVersion: 1 })).ok);
  const completed = await f.buyer.orders.complete({ id: 'po', expectedVersion: 3 }); assert(completed.ok);
  assert.equal(completed.value.state, 'completed'); assert.equal(completed.value.version, 4);
  const before = f.repository.commits;
  assert.deepEqual(await f.buyer.orders.cancel({ id: 'po', expectedVersion: 4 }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 4, receiptId: 'extra', quantities: [{ sku: 'a', quantity: 1 }] }), err({ kind: 'WrongState' }));
  assert.equal(f.repository.commits, before);
});
