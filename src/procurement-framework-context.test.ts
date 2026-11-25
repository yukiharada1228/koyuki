import test from 'node:test';
import assert from 'node:assert/strict';
import { err, type Result } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { procurementContext } from './experiments/procurement/context.js';
import { procurementFrameworkContext } from './experiments/procurement/context-framework.js';
import { MemoryProcurement, type ProcurementRepository, type StorageError } from './experiments/procurement/repository.js';
import type { Actor, Policy } from './experiments/procurement/domain.js';
const identity: Actor = { id: 'finance', role: 'finance', groupId: 'g', active: true };
const policy: Policy = { requestLimitCents: 1000, approverIds: ['approver'], receiptDepletion: 'available-locations' };
type Context = ReturnType<typeof procurementContext<StorageError>>;
type Framework = ReturnType<typeof procurementFrameworkContext<StorageError>>;
const proof = Symbol('request');
const inputs = {
  create: { id: 'new', lines: [], proof }, request: { id: 'rq', expectedVersion: 1, proof }, order: { id: 'po', expectedVersion: 1, proof },
  receipt: { id: 'rc', expectedVersion: 1, proof }, invoice: { id: 'inv', expectedVersion: 1, proof },
  inventory: { id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 1, proof },
  approval: { id: 'rq', expectedVersion: 1, approverId: 'approver', proof },
  place: { id: 'rq', expectedVersion: 1, orderId: 'next', supplier: 'supplier', proof },
  receive: { id: 'po', expectedVersion: 1, receiptId: 'next', quantities: [], proof },
  register: { id: 'po', expectedVersion: 1, invoiceId: 'next', amountCents: 200, proof },
  match: { id: 'inv', expectedVersion: 1, proof }, record: { id: 'inv', expectedVersion: 1, paymentId: 'next', reference: 'next', proof },
  payment: { id: 'pay', expectedVersion: 1, reason: 'cancel', proof },
};
const cases: readonly { name: keyof typeof inputs; run: (context: Context) => Promise<Result<unknown, StorageError>> }[] = [
  { name: 'create', run: context => context.create(inputs.create) }, { name: 'request', run: context => context.request(inputs.request) },
  { name: 'order', run: context => context.order(inputs.order) }, { name: 'receipt', run: context => context.receipt(inputs.receipt) },
  { name: 'invoice', run: context => context.invoice(inputs.invoice) }, { name: 'inventory', run: context => context.inventory(inputs.inventory) },
  { name: 'approval', run: context => context.approval(inputs.approval) }, { name: 'place', run: context => context.place(inputs.place) },
  { name: 'receive', run: context => context.receive(inputs.receive) }, { name: 'register', run: context => context.register(inputs.register) },
  { name: 'match', run: context => context.match(inputs.match) }, { name: 'record', run: context => context.record(inputs.record) },
  { name: 'payment', run: context => context.payment(inputs.payment) },
];
async function fixture() {
  const memory = new MemoryProcurement();
  const commands = (role: Actor['role']) => procurement(memory, { ...identity, id: role, role }, policy);
  const buyer = commands('buyer'), boss = commands('approver'), warehouse = commands('warehouse'), finance = commands('finance');
  for (const pending of [
    () => buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 100 }] }),
    () => buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }),
    () => boss.requests.approve({ id: 'rq', expectedVersion: 2 }),
    () => buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' }),
    () => warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 2 }] }),
    () => finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 200 }),
    () => finance.invoices.match({ id: 'inv', expectedVersion: 1 }),
    () => finance.invoices.approve({ id: 'inv', expectedVersion: 2 }),
    () => finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank' }),
  ]) assert((await pending()).ok);
  return memory;
}
function observe(memory: MemoryProcurement, options: { failAt?: number; throwAt?: number; missingStock?: boolean; defect?: Error } = {}) {
  const calls: string[] = [];
  const repository: ProcurementRepository = {
    read: async (kind, id, actor) => {
      calls.push(`read:${kind}:${id}:${actor.groupId}:${actor.id}`);
      if (calls.length === options.throwAt) throw options.defect;
      if (calls.length === options.failAt) return err({ kind: 'Conflict' });
      if (kind === 'stock' && options.missingStock) return err({ kind: 'NotFound' });
      return memory.read(kind, id, actor);
    },
    related: async (kind, id, actor) => {
      calls.push(`related:${kind}:${id}:${actor.groupId}:${actor.id}`);
      if (calls.length === options.throwAt) throw options.defect;
      return memory.related(kind, id, actor);
    },
    commit: async () => { throw Error('load must not commit'); },
  };
  return { calls, repository };
}
for (const item of cases) {
  test(`framework context ${item.name} preserves facts, query order and request references`, async () => {
    const memory = await fixture(), left = observe(memory), right = observe(memory);
    const baseline = procurementContext(left.repository, identity, policy), framework = procurementFrameworkContext(right.repository, identity, policy);
    assert.deepEqual([left.calls, right.calls], [[], []]);
    const a = await item.run(baseline), b = await item.run(framework); assert.deepEqual(b, a); assert.deepEqual(right.calls, left.calls);
    assert(b.ok && typeof b.value === 'object' && b.value !== null && 'input' in b.value && 'actor' in b.value);
    assert.equal(b.value.input, inputs[item.name]); assert.equal(b.value.actor, framework.actor); assert(Object.isFrozen(framework.actor));
  });
  if (item.name === 'create') continue; // This constructor has no port calls to fail.
  test(`framework context ${item.name} stops at every failed read`, async () => {
    const memory = await fixture(), observed = observe(memory); await item.run(procurementContext(observed.repository, identity, policy));
    assert(observed.calls.some(call => call.startsWith('read:')));
    for (let i = 0; i < observed.calls.length; i++) {
      if (!observed.calls[i]!.startsWith('read:')) continue;
      const left = observe(memory, { failAt: i + 1 }), right = observe(memory, { failAt: i + 1 });
      const a = await item.run(procurementContext(left.repository, identity, policy)), b = await item.run(procurementFrameworkContext(right.repository, identity, policy));
      assert.deepEqual(b, err({ kind: 'Conflict' })); assert.deepEqual(b, a); assert.deepEqual(right.calls, left.calls);
      assert.equal(right.calls.length, i + 1);
    }
  });
  test(`framework context ${item.name} propagates every port defect once`, async () => {
    const memory = await fixture(), observed = observe(memory); await item.run(procurementContext(observed.repository, identity, policy));
    assert(observed.calls.length > 0);
    const defect = Error('port defect');
    for (let i = 1; i <= observed.calls.length; i++) {
      const left = observe(memory, { throwAt: i, defect }), right = observe(memory, { throwAt: i, defect });
      await assert.rejects(item.run(procurementContext(left.repository, identity, policy)), cause => cause === defect);
      await assert.rejects(item.run(procurementFrameworkContext(right.repository, identity, policy)), cause => cause === defect);
      assert.deepEqual(right.calls, left.calls); assert.equal(right.calls.length, i);
    }
  });
}
test('all framework stock loaders retain the explicit NotFound-to-empty interpretation', async () => {
  const memory = await fixture();
  for (const name of ['inventory', 'receive', 'receipt'] as const) {
    const item = cases.find(item => item.name === name)!;
    const left = observe(memory, { missingStock: true }), right = observe(memory, { missingStock: true });
    const a = await item.run(procurementContext(left.repository, identity, policy)), b = await item.run(procurementFrameworkContext(right.repository, identity, policy));
    assert(a.ok && b.ok); assert.deepEqual(b, a); assert.deepEqual(right.calls, left.calls);
  }
});
test('framework actor and nested policy are captured before host configuration changes', async () => {
  const memory = await fixture(), actor = { ...identity }, configuration = { requestLimitCents: 1000, approverIds: ['approver'], secondApproval: { aboveCents: 100, approverId: 'other' } };
  const left = procurementContext(memory, actor, configuration), right = procurementFrameworkContext(memory, actor, configuration);
  actor.id = 'changed'; actor.groupId = 'other'; configuration.requestLimitCents = 0; configuration.approverIds.push('changed'); configuration.secondApproval.approverId = 'changed';
  const a = await left.approval(inputs.approval), b = await right.approval(inputs.approval); assert(a.ok && b.ok); assert.deepEqual(b, a);
  assert.equal(b.value.actor.id, identity.id); assert(Object.isFrozen(b.value.policy)); assert(Object.isFrozen(b.value.policy.approverIds)); assert(Object.isFrozen(b.value.policy.secondApproval));
});
function contracts(legacy: Context, framework: Framework) {
  const forward: Context = framework, backward: Framework = legacy;
  const refined = framework.request({ id: 'rq', expectedVersion: 1, reason: 'extra' });
  refined.then(result => { if (result.ok) { const reason: string = result.value.input.reason; void reason; } });
  // @ts-expect-error required fields are not widened by the Process loaders
  framework.receive({ id: 'po', expectedVersion: 1 });
  void forward; void backward;
}
void contracts;
