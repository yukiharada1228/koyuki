import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveIntoStock } from './experiments/procurement/inventory.js';
import { procurement, procurementChanges, type Committed } from './experiments/procurement/application.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { completeOrder, receiveOrder, type Actor, type Approved, type FinalReview, type Draft, type Request, type RuleError } from './experiments/procurement/domain.js';
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
    related: async (kind, parentId, identity) => memory.related(kind, parentId, identity),
    commit: (change, identity) => memory.commit(change, identity),
  };
  const as = (identity: Actor) => procurement(repository, identity, policy);
  await ordered({ repository: memory, as, buyer: as(actor('buyer')), boss: as(actor('approver')), warehouse: as(actor('warehouse')), finance: as(actor('finance')) });
  assert.equal(memory.list('order', actor('buyer')).length, 1);
});
// The generic shared save preserves this operation's actual decision result.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const api = setup().boss;
const exact: Equal<Extract<Awaited<ReturnType<typeof api.requests.approve>>, { ok: true }>['value'], Approved | FinalReview> = true;
const detailedApi = procurementChanges(new MemoryProcurement(), actor('approver'), policy);
const detailedExact: Equal<Extract<Awaited<ReturnType<typeof detailedApi.requests.approve>>, { ok: true }>['value'], Committed<Approved | FinalReview>> = true;
void detailedExact;
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

async function invoiced(f: ReturnType<typeof setup>) {
  await ordered(f);
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: lines.map(({ sku, quantity }) => ({ sku, quantity })) })).ok);
  assert((await f.finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 1000 })).ok);
  assert((await f.finance.invoices.match({ id: 'inv', expectedVersion: 1 })).ok);
}
test('an incorrect invoice can be voided and replaced while retaining its terminal record', async () => {
  const f = setup(); await ordered(f);
  assert((await f.finance.invoices.register({ id: 'po', expectedVersion: 1, invoiceId: 'bad', amountCents: 999 })).ok);
  assert.deepEqual(await f.finance.invoices.approve({ id: 'bad', expectedVersion: 1 }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.finance.invoices.void({ id: 'bad', expectedVersion: 1, reason: ' ' }), err({ kind: 'InvalidInput' }));
  const voided = await f.finance.invoices.void({ id: 'bad', expectedVersion: 1, reason: ' Wrong amount ' }); assert(voided.ok);
  assert.equal(voided.value.state, 'voided'); assert.equal('receiptIds' in voided.value, false);
  if (voided.value.state === 'voided') assert.equal(voided.value.reason, 'Wrong amount');
  const replacements = await Promise.all(['new1', 'new2'].map(invoiceId => f.finance.invoices.register({ id: 'po', expectedVersion: 3, invoiceId, amountCents: 1000 })));
  assert.equal(replacements.filter(result => result.ok).length, 1);
  assert.deepEqual(replacements.find(result => !result.ok), err({ kind: 'Conflict' }));
  assert.equal(f.repository.list('invoice', actor('finance')).length, 2);
  assert.deepEqual(await f.finance.invoices.match({ id: 'bad', expectedVersion: 2 }), err({ kind: 'WrongState' }));
});
test('finance approves only matched invoices; approved invoices remain compatible with order completion', async () => {
  const f = setup(); await invoiced(f);
  assert.deepEqual(await f.buyer.invoices.approve({ id: 'inv', expectedVersion: 2 }), err({ kind: 'Denied' }));
  assert.deepEqual(await f.finance.invoices.approve({ id: 'inv', expectedVersion: 1 }), err({ kind: 'Conflict' }));
  const approved = await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 }); assert(approved.ok);
  assert.equal(approved.value.state, 'approved');
  if (approved.value.state === 'approved') assert.equal(approved.value.approvedBy, 'finance');
  assert.deepEqual(await f.finance.invoices.void({ id: 'inv', expectedVersion: 3, reason: 'no' }), err({ kind: 'WrongState' }));
  assert((await f.buyer.orders.complete({ id: 'po', expectedVersion: 3 })).ok);
});
test('voiding races approval and order completion without leaving an accepted void invoice', async () => {
  for (const rival of ['approve', 'complete']) for (const voidFirst of [true, false]) {
    const f = setup(); await invoiced(f);
    const voidIt = () => f.finance.invoices.void({ id: 'inv', expectedVersion: 2, reason: 'cancel' });
    const other = () => rival === 'approve' ? f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 }) : f.buyer.orders.complete({ id: 'po', expectedVersion: 3 });
    const results = await Promise.all(voidFirst ? [voidIt(), other()] : [other(), voidIt()]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const failed = results.find(result => !result.ok); assert(failed && !failed.ok);
    assert(['Conflict', ...(rival === 'complete' ? ['InvoiceMismatch'] : [])].includes(failed.error.kind));
    const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok);
    const order = f.repository.read('order', 'po', actor('buyer')); assert(order.ok);
    if (invoice.value.state === 'voided') assert.equal(order.value.state, 'placed');
    if (order.value.state === 'completed') assert.equal(invoice.value.state, 'matched');
  }
});

test('a completion plan created before invoice voiding fails CAS without completing the order', async () => {
  const f = setup(); await invoiced(f);
  const order = f.repository.read('order', 'po', actor('buyer')); assert(order.ok);
  const change = completeOrder({ input: { id: 'po', expectedVersion: 3 }, actor: actor('buyer'), current: order.value,
    receipts: f.repository.list('receipt', actor('buyer')), invoices: f.repository.list('invoice', actor('buyer')) }); assert(change.ok);
  assert((await f.finance.invoices.void({ id: 'inv', expectedVersion: 2, reason: 'incorrect' })).ok);
  assert.deepEqual(await f.repository.commit(change.value, actor('buyer')), err({ kind: 'Conflict' }));
  const persisted = f.repository.read('order', 'po', actor('buyer')); assert(persisted.ok); assert.equal(persisted.value.state, 'placed');
});

test('payment records derive their amount from an approved invoice and can be cancelled and replaced', async () => {
  const f = setup(); await invoiced(f);
  assert.deepEqual(await f.finance.payments.record({ id: 'inv', expectedVersion: 2, paymentId: 'pay', reference: 'bank-1' }), err({ kind: 'WrongState' }));
  assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
  const injected = { id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank-1', amountCents: 1 };
  const recorded = await f.finance.payments.record(injected);
  assert(recorded.ok); assert.equal(recorded.value.amountCents, 1000); assert.equal(recorded.value.recordedBy, 'finance');
  assert.deepEqual(await f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'duplicate', reference: 'bank-2' }), err({ kind: 'AlreadyExists' }));
  const cancelled = await f.finance.payments.cancel({ id: 'pay', expectedVersion: 1, reason: ' Wrong reference ' }); assert(cancelled.ok);
  assert.equal(cancelled.value.state, 'cancelled');
  if (cancelled.value.state === 'cancelled') assert.equal(cancelled.value.reason, 'Wrong reference');
  assert.deepEqual(await f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'reuse', reference: 'bank-1' }), err({ kind: 'Conflict' }));
  assert((await f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'replacement', reference: 'bank-2' })).ok);
  assert.equal(f.repository.list('payment', actor('finance')).length, 2);
  assert.deepEqual(await f.finance.payments.cancel({ id: 'pay', expectedVersion: 2, reason: 'again' }), err({ kind: 'WrongState' }));
});
test('concurrent payment records and cancellations have one winner with retained history', async () => {
  const f = setup(); await invoiced(f); assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
  const results = await Promise.all(['a', 'b'].map(paymentId => f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId, reference: paymentId })));
  assert.equal(results.filter(result => result.ok).length, 1); assert.deepEqual(results.find(result => !result.ok), err({ kind: 'Conflict' }));
  const saved = f.repository.list('payment', actor('finance'))[0]; assert(saved);
  const cancellations = await Promise.all(['one', 'two'].map(reason => f.finance.payments.cancel({ id: saved.id, expectedVersion: 1, reason })));
  assert.equal(cancellations.filter(result => result.ok).length, 1); assert.deepEqual(cancellations.find(result => !result.ok), err({ kind: 'Conflict' }));
  assert.equal(f.repository.list('payment', actor('finance'))[0]?.version, 2);
});
test('payment commands enforce finance identity, scope, versions, reference and cancellation reason', async () => {
  const f = setup(); await invoiced(f); assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
  const input = { id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank-1' };
  assert.deepEqual(await f.buyer.payments.record(input), err({ kind: 'Denied' }));
  assert.deepEqual(await f.as(actor('finance', 'finance', 'foreign')).payments.record(input), err({ kind: 'NotFound' }));
  assert.deepEqual(await f.finance.payments.record({ ...input, reference: ' ' }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await f.finance.payments.record({ ...input, expectedVersion: 2 }), err({ kind: 'Conflict' }));
  assert((await f.finance.payments.record(input)).ok);
  const before = f.repository.commits;
  assert.deepEqual(await f.buyer.payments.cancel({ id: 'pay', expectedVersion: 1, reason: 'no' }), err({ kind: 'Denied' }));
  assert.deepEqual(await f.finance.payments.cancel({ id: 'pay', expectedVersion: 1, reason: ' ' }), err({ kind: 'InvalidInput' }));
  assert.equal(f.repository.commits, before);
});

test('returning a receipt invalidates invoice matching and allows replacement receipt quantities', async () => {
  const f = setup(); await invoiced(f);
  const returned = await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: ' Defective goods ' }); assert(returned.ok);
  assert.equal(returned.value.state, 'returned');
  const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok);
  assert.equal(invoice.value.state, 'registered'); assert.equal(invoice.value.version, 3); assert.equal('receiptIds' in invoice.value, false);
  assert.deepEqual(await f.finance.invoices.match({ id: 'inv', expectedVersion: 3 }), err({ kind: 'InvoiceMismatch' }));
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 4, receiptId: 'replacement', quantities: lines.map(({ sku, quantity }) => ({ sku, quantity })) })).ok);
  const matched = await f.finance.invoices.match({ id: 'inv', expectedVersion: 3 }); assert(matched.ok);
  if (matched.value.state === 'matched') assert.deepEqual(matched.value.receiptIds, ['replacement']);
  assert((await f.buyer.orders.complete({ id: 'po', expectedVersion: 5 })).ok);
});
test('receipt corrections replace quantities and revalidate cumulative order limits before saving', async () => {
  const f = setup(); await invoiced(f);
  const before = f.repository.commits;
  assert.deepEqual(await f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 3 }] }), err({ kind: 'QuantityExceeded' }));
  assert.deepEqual(await f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [] }), err({ kind: 'InvalidInput' }));
  assert.equal(f.repository.commits, before);
  const corrected = await f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 1 }] }); assert(corrected.ok);
  assert.equal(corrected.value.version, 2);
  assert.deepEqual(await f.finance.invoices.approve({ id: 'inv', expectedVersion: 3 }), err({ kind: 'WrongState' }));
  assert((await f.warehouse.receipts.receive({ id: 'po', expectedVersion: 4, receiptId: 'additional', quantities: [{ sku: 'a', quantity: 1 }, { sku: 'b', quantity: 1 }] })).ok);
  assert.deepEqual(await f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 2, quantities: [{ sku: 'a', quantity: 2 }] }), err({ kind: 'QuantityExceeded' }));
  assert((await f.finance.invoices.match({ id: 'inv', expectedVersion: 3 })).ok);
});
test('approved invoices, completed orders, wrong actors and returned receipts reject quantity changes', async () => {
  const f = setup(); await invoiced(f);
  assert.deepEqual(await f.buyer.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'no' }), err({ kind: 'Denied' }));
  assert.deepEqual(await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: ' ' }), err({ kind: 'InvalidInput' }));
  assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
  assert.deepEqual(await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'no' }), err({ kind: 'WrongState' }));
  assert.deepEqual(await f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: lines }), err({ kind: 'WrongState' }));
  const g = setup(); await invoiced(g); assert((await g.buyer.orders.complete({ id: 'po', expectedVersion: 3 })).ok);
  assert.deepEqual(await g.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'no' }), err({ kind: 'WrongState' }));
  const h = setup(); await invoiced(h); assert((await h.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'no' })).ok);
  assert.deepEqual(await h.warehouse.receipts.correct({ id: 'rc', expectedVersion: 2, quantities: lines }), err({ kind: 'WrongState' }));
});
test('quantity changes race invoice approval and order completion without preserving obsolete matching', async () => {
  for (const rival of ['approve', 'complete']) for (const changeFirst of [true, false]) {
    const f = setup(); await invoiced(f);
    const change = () => f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' });
    const other = () => rival === 'approve' ? f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 }) : f.buyer.orders.complete({ id: 'po', expectedVersion: 3 });
    const results = await Promise.all(changeFirst ? [change(), other()] : [other(), change()]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const receipt = f.repository.read('receipt', 'rc', actor('warehouse')); assert(receipt.ok);
    const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok);
    const order = f.repository.read('order', 'po', actor('buyer')); assert(order.ok);
    if (receipt.value.state === 'returned') { assert.equal(invoice.value.state, 'registered'); assert.equal(order.value.state, 'placed'); }
    else assert(invoice.value.state === 'approved' || order.value.state === 'completed');
  }
});

test('concurrent return and correction save exactly one composite change', async () => {
  const f = setup(); await invoiced(f);
  const before = f.repository.commits;
  const results = await Promise.all([
    f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }),
    f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 1 }] }),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.find(result => !result.ok), err({ kind: 'Conflict' }));
  assert.equal(f.repository.commits, before + 1);
  const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok); assert.equal(invoice.value.state, 'registered'); assert.equal(invoice.value.version, 3);
  const order = f.repository.read('order', 'po', actor('buyer')); assert(order.ok); assert.equal(order.value.version, 4);
});

test('receipts feed inventory; reservations and relocated quantities prevent returns without partial updates', async () => {
  const f = setup(); await invoiced(f);
  const base = { id: 'warehouse', sku: 'a', location: 'receiving', quantity: 1 };
  assert((await f.warehouse.inventory.reserve({ ...base, expectedVersion: 1 })).ok);
  let before = f.repository.commits;
  assert.deepEqual(await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }), err({ kind: 'InsufficientStock' }));
  assert.equal(f.repository.commits, before);
  const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok); assert.equal(invoice.value.state, 'matched');
  assert((await f.warehouse.inventory.release({ ...base, expectedVersion: 2 })).ok);
  assert((await f.warehouse.inventory.move({ ...base, expectedVersion: 3, destination: 'shelf' })).ok);
  before = f.repository.commits;
  assert.deepEqual(await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' }), err({ kind: 'InsufficientStock' }));
  assert.equal(f.repository.commits, before);
  assert((await f.warehouse.inventory.move({ ...base, location: 'shelf', destination: 'receiving', expectedVersion: 4 })).ok);
  assert((await f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' })).ok);
  const stock = f.repository.read('stock', 'warehouse', actor('warehouse')); assert(stock.ok);
  assert.equal(stock.value.version, 6); assert.equal(stock.value.positions.reduce((sum, row) => sum + row.onHand, 0), 0);
});
test('inventory adjustment, reservation, release and movement preserve safe nonnegative quantities', async () => {
  const f = setup(), base = { id: 'warehouse', sku: 'a', location: 'shelf' };
  const adjusted = await f.warehouse.inventory.adjust({ ...base, expectedVersion: 0, quantity: 5, reason: ' Opening count ' }); assert(adjusted.ok);
  assert.deepEqual(adjusted.value.lastAdjustment, { reason: 'Opening count', by: 'warehouse' });
  assert((await f.warehouse.inventory.reserve({ ...base, expectedVersion: 1, quantity: 3 })).ok);
  const before = f.repository.commits;
  assert.deepEqual(await f.warehouse.inventory.adjust({ ...base, expectedVersion: 2, quantity: 2, reason: 'count' }), err({ kind: 'InsufficientStock' }));
  assert.deepEqual(await f.warehouse.inventory.move({ ...base, expectedVersion: 2, quantity: 3, destination: 'other' }), err({ kind: 'InsufficientStock' }));
  assert.deepEqual(await f.warehouse.inventory.release({ ...base, expectedVersion: 2, quantity: 4 }), err({ kind: 'InsufficientStock' }));
  assert.equal(f.repository.commits, before);
  const moved = await f.warehouse.inventory.move({ ...base, expectedVersion: 2, quantity: 2, destination: 'other' }); assert(moved.ok);
  assert.equal(moved.value.positions.reduce((sum, row) => sum + row.onHand, 0), 5);
  assert.equal(moved.value.positions.reduce((sum, row) => sum + row.reserved, 0), 3);
  assert((await f.warehouse.inventory.release({ ...base, expectedVersion: 3, quantity: 3 })).ok);
  assert((await f.warehouse.inventory.adjust({ ...base, expectedVersion: 4, quantity: 0, reason: 'recount' })).ok);
});
test('inventory commands reject wrong actors, versions, scope, identifiers and numeric boundaries', async () => {
  const f = setup(), base = { id: 'warehouse', expectedVersion: 0, sku: 'a', location: 'shelf', quantity: 5, reason: 'count' };
  assert.deepEqual(await f.buyer.inventory.adjust(base), err({ kind: 'Denied' }));
  for (const input of [{ ...base, quantity: -1 }, { ...base, quantity: Infinity }, { ...base, quantity: Number.MAX_SAFE_INTEGER + 1 }, { ...base, expectedVersion: -1 }, { ...base, sku: ' ' }, { ...base, reason: ' ' }]) assert.deepEqual(await f.warehouse.inventory.adjust(input), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await f.warehouse.inventory.adjust({ ...base, id: 'other' }), err({ kind: 'TargetMismatch' }));
  assert((await f.warehouse.inventory.adjust(base)).ok);
  assert.deepEqual(await f.warehouse.inventory.reserve({ ...base, quantity: 1 }), err({ kind: 'Conflict' }));
  assert.deepEqual(await f.warehouse.inventory.move({ ...base, expectedVersion: 1, destination: 'shelf' }), err({ kind: 'InvalidInput' }));
  const foreign = f.as(actor('warehouse', 'warehouse', 'foreign'));
  assert.deepEqual(await foreign.inventory.reserve({ ...base, quantity: 1 }), err({ kind: 'InsufficientStock' }));
});
test('concurrent reservations cannot overallocate; receipt correction cannot reduce reserved stock', async () => {
  const f = setup(); await invoiced(f);
  const base = { id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 2 };
  const results = await Promise.all([f.warehouse.inventory.reserve(base), f.warehouse.inventory.reserve(base)]);
  assert.equal(results.filter(result => result.ok).length, 1); assert.deepEqual(results.find(result => !result.ok), err({ kind: 'Conflict' }));
  const before = f.repository.commits;
  assert.deepEqual(await f.warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 1 }] }), err({ kind: 'InsufficientStock' }));
  assert.equal(f.repository.commits, before);
  const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok); assert.equal(invoice.value.state, 'matched');
});
test('return racing reservation preserves inventory and matching consistently', async () => {
  for (const returnFirst of [true, false]) {
    const f = setup(); await invoiced(f);
    const reserve = () => f.warehouse.inventory.reserve({ id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 2 });
    const returning = () => f.warehouse.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'defect' });
    const results = await Promise.all(returnFirst ? [returning(), reserve()] : [reserve(), returning()]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const stock = f.repository.read('stock', 'warehouse', actor('warehouse')); assert(stock.ok);
    assert(stock.value.positions.every(row => row.onHand >= row.reserved && row.reserved >= 0));
    const receipt = f.repository.read('receipt', 'rc', actor('warehouse')); assert(receipt.ok);
    const invoice = f.repository.read('invoice', 'inv', actor('finance')); assert(invoice.ok);
    assert.equal(invoice.value.state, receipt.value.state === 'returned' ? 'registered' : 'matched');
  }
});

test('a clone failure in inventory cannot partially save order and receipt writes', async () => {
  const f = setup(); await ordered(f);
  const order = f.repository.read('order', 'po', actor('warehouse')); assert(order.ok);
  const change = receiveIntoStock({ input: { id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] },
    actor: actor('warehouse'), current: order.value, receipts: [], stock: null }); assert(change.ok);
  const writes = change.value.writes.map(entity => entity.kind === 'stock' ? { ...entity, debug: () => 1 } : entity);
  const before = f.repository.commits;
  await assert.rejects(f.repository.commit({ ...change.value, writes }, actor('warehouse')));
  assert.equal(f.repository.commits, before);
  assert.equal(f.repository.list('receipt', actor('warehouse')).length, 0);
  assert.equal(f.repository.list('stock', actor('warehouse')).length, 0);
  const persisted = f.repository.read('order', 'po', actor('warehouse')); assert(persisted.ok); assert.equal(persisted.value.version, 1);
});

if (false) {
  const inventory = setup().warehouse.inventory;
  // @ts-expect-error move requires a destination; other operations do not fabricate it
  inventory.move({ id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 1 });
  // @ts-expect-error adjustment requires its own reason
  inventory.adjust({ id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 0 });
}

test('the procurement application needs related queries rather than whole-kind listings', async () => {
  const memory = new MemoryProcurement();
  const repository: ProcurementRepository = {
    read: (kind, id, identity) => memory.read(kind, id, identity),
    related: (kind, parentId, identity) => memory.related(kind, parentId, identity),
    commit: (change, identity) => memory.commit(change, identity),
  };
  const as = (identity: Actor) => procurement(repository, identity, policy);
  const f = { repository: memory, as, buyer: as(actor('buyer')), boss: as(actor('approver')), warehouse: as(actor('warehouse')), finance: as(actor('finance')) };
  await invoiced(f);
  assert.equal(memory.related('order', 'rq', actor('buyer')).length, 1);
  assert.equal(memory.related('order', 'other', actor('buyer')).length, 0);
  assert.equal(memory.related('receipt', 'po', actor('warehouse', 'warehouse', 'foreign')).length, 0);
  assert((await f.finance.invoices.approve({ id: 'inv', expectedVersion: 2 })).ok);
  assert((await f.finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank-1' })).ok);
  assert.equal(memory.related('payment', 'inv', actor('finance')).length, 1);
});
