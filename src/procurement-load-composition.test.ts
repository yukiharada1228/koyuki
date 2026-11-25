import test from 'node:test';
import assert from 'node:assert/strict';
import { err } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { procurementContext } from './experiments/procurement/context.js';
import { procurementProcessContext } from './experiments/procurement/context-process.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { returnFromStock } from './experiments/procurement/inventory.js';
import type { Actor, VersionInput } from './experiments/procurement/domain.js';

const actor = (role: Actor['role']): Actor => ({ role, id: role, groupId: 'g', active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
async function fixture() {
  const repository = new MemoryProcurement();
  const buyer = procurement(repository, actor('buyer'), policy);
  const boss = procurement(repository, actor('approver'), policy);
  const warehouse = procurement(repository, actor('warehouse'), policy);
  const finance = procurement(repository, actor('finance'), policy);
  assert((await buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 100 }] })).ok);
  assert((await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
  assert((await boss.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
  assert((await buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
  assert((await warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 1 }] })).ok);
  assert((await finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 200 })).ok);
  return repository;
}
function observed(memory: MemoryProcurement, options: { failAt?: number; missingStock?: boolean; throwAt?: number } = {}) {
  const calls: string[] = [];
  const defect = new Error('read defect');
  const repository: ProcurementRepository = {
    read: async (kind, id, identity) => {
      calls.push(`read:${kind}:${id}:${identity.groupId}:${identity.id}`);
      if (calls.length === options.throwAt) throw defect;
      if (calls.length === options.failAt) return err({ kind: 'Conflict' });
      if (kind === 'stock' && options.missingStock) return err({ kind: 'NotFound' });
      return memory.read(kind, id, identity);
    },
    related: async (kind, id, identity) => {
      calls.push(`related:${kind}:${id}:${identity.groupId}:${identity.id}`);
      if (calls.length === options.throwAt) throw defect;
      return memory.related(kind, id, identity);
    },
    commit: async () => { throw new Error('load must not write'); },
  };
  return { calls, defect, repository };
}
for (const name of ['invoice', 'receipt'] as const) {
  test(`composed ${name} loading preserves successful facts, generic input and query order`, async () => {
    const memory = await fixture();
    const before = memory.commits;
    const left = observed(memory), right = observed(memory);
    const input = { id: name === 'invoice' ? 'inv' : 'rc', expectedVersion: 1, reason: 'retain generic input', proof: Symbol('host-owned') };
    const identity = actor('finance');
    const baseline = procurementContext(left.repository, identity, policy);
    const composed = procurementProcessContext(right.repository, identity);
    assert.deepEqual(left.calls, []); assert.deepEqual(right.calls, []);
    const a = await baseline[name](input), b = await composed[name](input);
    assert.deepEqual(b, a); assert.deepEqual(right.calls, left.calls);
    assert(b.ok); assert.equal(b.value.input, input); assert.equal(b.value.input.proof, input.proof);
    assert.equal(b.value.input.reason, 'retain generic input');
    assert(Object.isFrozen(b.value.actor)); assert.equal(memory.commits, before);
    const again = await composed[name](input); assert.deepEqual(again, a);
    assert.equal(right.calls.length, left.calls.length * 2); // no implicit memoization
  });
  test(`composed ${name} loading stops at every failed read before later queries`, async () => {
    const memory = await fixture();
    for (let failAt = 1; failAt <= (name === 'invoice' ? 2 : 3); failAt++) {
      const left = observed(memory, { failAt }), right = observed(memory, { failAt });
      const input = { id: name === 'invoice' ? 'inv' : 'rc', expectedVersion: 1 };
      const a = await procurementContext(left.repository, actor('finance'), policy)[name](input);
      const b = await procurementProcessContext(right.repository, actor('finance'))[name](input);
      assert.deepEqual(b, err({ kind: 'Conflict' })); assert.deepEqual(b, a);
      assert.equal(right.calls.length, failAt); assert.deepEqual(right.calls, left.calls);
    }
  });
  test(`composed ${name} loading propagates each read/query rejection without retry`, async () => {
    const memory = await fixture();
    for (let throwAt = 1; throwAt <= (name === 'invoice' ? 2 : 5); throwAt++) {
      const left = observed(memory, { throwAt }), right = observed(memory, { throwAt });
      const input = { id: name === 'invoice' ? 'inv' : 'rc', expectedVersion: 1 };
      await assert.rejects(procurementContext(left.repository, actor('finance'), policy)[name](input), error => error === left.defect);
      await assert.rejects(procurementProcessContext(right.repository, actor('finance'))[name](input), error => error === right.defect);
      assert.equal(right.calls.length, throwAt); assert.deepEqual(right.calls, left.calls);
    }
  });
}
test('composed receipt loading preserves optional stock and scoped NotFound', async () => {
  const memory = await fixture();
  const left = observed(memory, { missingStock: true }), right = observed(memory, { missingStock: true });
  const input = { id: 'rc', expectedVersion: 1 };
  const a = await procurementContext(left.repository, actor('warehouse'), policy).receipt(input);
  const b = await procurementProcessContext(right.repository, actor('warehouse')).receipt(input);
  assert.deepEqual(b, a); assert(b.ok); assert.equal(b.value.stock, null);
  assert.deepEqual(right.calls, left.calls);
  const foreign = { ...actor('warehouse'), groupId: 'foreign' };
  const scoped = observed(memory);
  assert.deepEqual(await procurementProcessContext(scoped.repository, foreign).receipt(input), err({ kind: 'NotFound' }));
  assert.equal(scoped.calls.length, 1);
});

test('composed receipt facts drive the unchanged return rule and composite save', async () => {
  const left = await fixture(), right = await fixture(), identity = actor('warehouse');
  const input = { id: 'rc', expectedVersion: 1, reason: 'damaged' };
  const a = await procurementContext(left, identity, policy).receipt(input);
  const b = await procurementProcessContext(right, identity).receipt(input);
  assert(a.ok); assert(b.ok);
  const oldDecision = returnFromStock(a.value), newDecision = returnFromStock(b.value);
  assert.deepEqual(newDecision, oldDecision); assert(oldDecision.ok); assert(newDecision.ok);
  assert.deepEqual(await right.commit(newDecision.value, identity), await left.commit(oldDecision.value, identity));
  for (const kind of ['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const) {
    assert.deepEqual(right.list(kind, identity), left.list(kind, identity));
  }
});

// Retain each caller's input refinement and exactly the same success/failure contract.
type Refined = VersionInput & { reason: string };
type SameContract<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Baseline = ReturnType<typeof procurementContext>;
type Composed = ReturnType<typeof procurementProcessContext>;
declare const baselineTypes: Baseline;
declare const composedTypes: Composed;
const sameInvoice: SameContract<Awaited<ReturnType<typeof baselineTypes.invoice<Refined>>>, Awaited<ReturnType<typeof composedTypes.invoice<Refined>>>> = true;
const sameReceipt: SameContract<Awaited<ReturnType<typeof baselineTypes.receipt<Refined>>>, Awaited<ReturnType<typeof composedTypes.receipt<Refined>>>> = true;
void sameInvoice; void sameReceipt;
