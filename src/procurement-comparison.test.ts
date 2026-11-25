import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Result } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { MemoryProcurement, type ProcurementRepository, type StorageError } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { StudyFactory } from './experiments/procurement/comparison-contract.js';
import type { Actor, Approved, FinalReview, Entity, RuleError } from './experiments/procurement/domain.js';
const factories = { koyuki: procurement, plain: plainProcurement, helper: helperProcurement } satisfies Record<string, StudyFactory>;
const actor = (role: Actor['role'], id: string = role): Actor => ({ id, role, groupId: 'g1', active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver', 'other'] };
type Inspectable = ProcurementRepository & { list<K extends Entity['kind']>(kind: K, identity: Actor): readonly Extract<Entity, { kind: K }>[] };
async function story(factory: StudyFactory, repository: Inspectable) {
  const buyer = factory(repository, actor('buyer'), policy), boss = factory(repository, actor('approver'), policy);
  const other = factory(repository, actor('approver', 'other'), policy), warehouse = factory(repository, actor('warehouse'), policy), finance = factory(repository, actor('finance'), policy);
  const outcomes: { operation: string; value: unknown }[] = [], covered = new Set<string>();
  async function success(operation: string, pending: Promise<Result<unknown, unknown>>) {
    const result = await pending; assert(result.ok, `${operation}: ${JSON.stringify(result)}`);
    covered.add(operation); outcomes.push({ operation, value: result.value });
  }
  const lines = [{ sku: 'a', quantity: 2, unitCents: 500 }];
  await success('request.create', buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }] }));
  await success('request.edit', buyer.requests.edit({ id: 'rq', expectedVersion: 1, lines }));
  await success('request.submit', buyer.requests.submit({ id: 'rq', expectedVersion: 2, approverId: 'approver' }));
  await success('request.withdraw', buyer.requests.withdraw({ id: 'rq', expectedVersion: 3 }));
  await success('request.submit', buyer.requests.submit({ id: 'rq', expectedVersion: 4, approverId: 'approver' }));
  await success('request.reassign', boss.requests.reassign({ id: 'rq', expectedVersion: 5, approverId: 'other' }));
  await success('request.return', other.requests.return({ id: 'rq', expectedVersion: 6 }));
  await success('request.submit', buyer.requests.submit({ id: 'rq', expectedVersion: 7, approverId: 'approver' }));
  await success('request.approve', boss.requests.approve({ id: 'rq', expectedVersion: 8 }));
  await success('request.create', buyer.requests.create({ id: 'rejected', lines }));
  await success('request.submit', buyer.requests.submit({ id: 'rejected', expectedVersion: 1, approverId: 'approver' }));
  await success('request.reject', boss.requests.reject({ id: 'rejected', expectedVersion: 2, reason: 'duplicate' }));
  await success('order.place', buyer.orders.place({ id: 'rq', expectedVersion: 9, orderId: 'cancelled', supplier: 'supplier' }));
  await success('order.amend', buyer.orders.amend({ id: 'cancelled', expectedVersion: 1, supplier: 'changed' }));
  await success('order.cancel', buyer.orders.cancel({ id: 'cancelled', expectedVersion: 2 }));
  await success('order.place', buyer.orders.place({ id: 'rq', expectedVersion: 9, orderId: 'po', supplier: 'supplier' }));
  await success('receipt.receive', warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'returned', quantities: [{ sku: 'a', quantity: 1 }] }));
  await success('receipt.correct', warehouse.receipts.correct({ id: 'returned', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }] }));
  await success('receipt.return', warehouse.receipts.return({ id: 'returned', expectedVersion: 2, reason: 'defect' }));
  await success('receipt.receive', warehouse.receipts.receive({ id: 'po', expectedVersion: 4, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 2 }] }));
  await success('invoice.register', finance.invoices.register({ id: 'po', expectedVersion: 5, invoiceId: 'voided', amountCents: 999 }));
  await success('invoice.void', finance.invoices.void({ id: 'voided', expectedVersion: 1, reason: 'wrong amount' }));
  await success('invoice.register', finance.invoices.register({ id: 'po', expectedVersion: 7, invoiceId: 'inv', amountCents: 1000 }));
  await success('invoice.match', finance.invoices.match({ id: 'inv', expectedVersion: 1 }));
  await success('invoice.approve', finance.invoices.approve({ id: 'inv', expectedVersion: 2 }));
  await success('order.complete', buyer.orders.complete({ id: 'po', expectedVersion: 8 }));
  await success('payment.record', finance.payments.record({ id: 'inv', expectedVersion: 3, paymentId: 'pay', reference: 'bank-1' }));
  await success('payment.cancel', finance.payments.cancel({ id: 'pay', expectedVersion: 1, reason: 'wrong reference' }));
  const stock = { id: 'warehouse', sku: 'a', location: 'receiving', quantity: 1 };
  await success('inventory.reserve', warehouse.inventory.reserve({ ...stock, expectedVersion: 4 }));
  await success('inventory.release', warehouse.inventory.release({ ...stock, expectedVersion: 5 }));
  await success('inventory.move', warehouse.inventory.move({ ...stock, expectedVersion: 6, destination: 'shelf' }));
  await success('inventory.adjust', warehouse.inventory.adjust({ ...stock, location: 'shelf', quantity: 2, expectedVersion: 7, reason: 'count' }));
  assert.equal(covered.size, 25); assert.equal(outcomes.length, 32);
  const persisted = (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor('finance')));
  assert.equal(persisted.find(entity => entity.kind === 'request' && entity.id === 'rq')?.version, 9);
  const completed = persisted.find(entity => entity.kind === 'order' && entity.id === 'po'); assert(completed?.kind === 'order'); assert.equal(completed.state, 'completed');
  const inventory = persisted.find(entity => entity.kind === 'stock'); assert(inventory?.kind === 'stock');
  assert.equal(inventory.version, 8); assert.equal(inventory.positions.reduce((sum, row) => sum + row.onHand, 0), 3);
  assert.equal(inventory.positions.reduce((sum, row) => sum + row.reserved, 0), 0);
  return { outcomes, persisted };
}
for (const backend of ['memory', 'sqlite'] as const) for (const [name, factory] of Object.entries(factories)) {
  test(`25-operation parity: ${name} / ${backend}`, async () => {
    const expected = await story(procurement, new MemoryProcurement());
    const directory = backend === 'sqlite' ? mkdtempSync(join(tmpdir(), 'koyuki-comparison-')) : null;
    const repository = directory ? new SqliteProcurement(join(directory, 'study.sqlite'), 'g1') : new MemoryProcurement();
    try { assert.deepEqual(await story(factory, repository), expected); }
    finally { if (repository instanceof SqliteProcurement) repository.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  });
}
test('all three orchestration styles stop failed loads and rules before saving', async () => {
  for (const factory of Object.values(factories)) {
    const repository = new MemoryProcurement(), buyer = factory(repository, actor('buyer'), policy);
    assert.deepEqual(await buyer.requests.create({ id: 'bad', lines: [] }), { ok: false, error: { kind: 'InvalidInput' } });
    assert.deepEqual(await buyer.requests.approve({ id: 'missing', expectedVersion: 1 }), { ok: false, error: { kind: 'NotFound' } });
    assert.equal(repository.commits, 0);
    assert((await buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 1000 }] })).ok);
    const before = repository.commits;
    const denied = factory(repository, actor('buyer', 'other'), policy);
    assert.deepEqual(await denied.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), { ok: false, error: { kind: 'Denied' } });
    const changedPolicy = factory(repository, actor('buyer'), { ...policy, requestLimitCents: 999 });
    assert.deepEqual(await changedPolicy.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), { ok: false, error: { kind: 'BudgetExceeded' } });
    assert.equal(repository.commits, before);
  }
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const plain = plainProcurement(new MemoryProcurement(), actor('approver'), policy);
const helper = helperProcurement(new MemoryProcurement(), actor('approver'), policy);
type Success<R> = R extends { ok: true; value: infer T } ? T : never;
const plainExact: Equal<Success<Awaited<ReturnType<typeof plain.requests.approve>>>, Approved | FinalReview> = true;
const helperExact: Equal<Success<Awaited<ReturnType<typeof helper.requests.approve>>>, Approved | FinalReview> = true;
void plainExact; void helperExact;
if (false) {
  // @ts-expect-error plain TypeScript preserves the operation's required fields
  plain.requests.submit({ id: 'rq', expectedVersion: 1 });
  // @ts-expect-error the helper preserves the operation's required fields too
  helper.inventory.move({ id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 1 });
}
