import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { baselineReplay } from './experiments/procurement/baseline-replay.js';
import { procurementComposedReads } from './experiments/procurement/context-application.js';
import { procurementContext } from './experiments/procurement/context.js';
import { procurementProcessContext } from './experiments/procurement/context-process.js';
import { returnFromStock } from './experiments/procurement/inventory.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { Actor, Policy } from './experiments/procurement/domain.js';
import type { StudyFactory } from './experiments/procurement/comparison-contract.js';
import type { Result } from './framework/index.js';
const factories = { koyuki: procurement, plain: plainProcurement, helper: helperProcurement } satisfies Record<string, StudyFactory>;
const actor = (role: Actor['role']): Actor => ({ id: role, role, groupId: 'g1', active: true });
const policy: Policy = { requestLimitCents: 2000, approverIds: ['approver'], receiptDepletion: 'available-locations' };
const success = <T, E>(result: Result<T, E>): T => { assert(result.ok, JSON.stringify(result)); return result.value; };
function store(backend: 'memory' | 'sqlite') {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-return-change-')), path = join(directory, 'study.sqlite');
  let repository = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(path, 'g1');
  return { path, get repository() { return repository; }, reopen() {
    if (repository instanceof SqliteProcurement) { repository.close(); repository = new SqliteProcurement(path, 'g1'); }
  }, close() { if (repository instanceof SqliteProcurement) repository.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function seed(repository: MemoryProcurement | SqliteProcurement, factory: StudyFactory) {
  const buyer = factory(repository, actor('buyer'), policy), boss = factory(repository, actor('approver'), policy);
  const warehouse = factory(repository, actor('warehouse'), policy), finance = factory(repository, actor('finance'), policy);
  success(await buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 6, unitCents: 100 }, { sku: 'b', quantity: 2, unitCents: 100 }] }));
  success(await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }));
  success(await boss.requests.approve({ id: 'rq', expectedVersion: 2 }));
  success(await buyer.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 's' }));
  success(await warehouse.receipts.receive({ id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 6 }, { sku: 'b', quantity: 2 }] }));
  success(await finance.invoices.register({ id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 800 }));
  success(await finance.invoices.match({ id: 'inv', expectedVersion: 1 }));
  const base = { id: 'warehouse', sku: 'a', location: 'receiving' };
  success(await warehouse.inventory.adjust({ ...base, expectedVersion: 1, quantity: 8, reason: 'counted extra stock' }));
  success(await warehouse.inventory.move({ ...base, expectedVersion: 2, quantity: 2, destination: 'beta' }));
  success(await warehouse.inventory.move({ ...base, expectedVersion: 3, quantity: 3, destination: 'alpha' }));
  success(await warehouse.inventory.reserve({ ...base, location: 'alpha', expectedVersion: 4, quantity: 2 }));
  success(await warehouse.inventory.move({ ...base, sku: 'b', expectedVersion: 5, quantity: 2, destination: 'zeta' }));
}
const snapshot = (repository: MemoryProcurement | SqliteProcurement) => (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).map(kind => repository.list(kind, actor('warehouse')));
const outcomes = new Map<string, unknown>();
for (const backend of ['memory', 'sqlite'] as const) for (const [name, factory] of Object.entries(factories)) {
  test(`distributed receipt depletion / ${name} / ${backend}`, async () => {
    const disk = store(backend);
    try {
      await seed(disk.repository, factory);
      const initial = snapshot(disk.repository);
      const legacy = factory(disk.repository, actor('warehouse'), { ...policy, receiptDepletion: undefined });
      const injected = { id: 'rc', expectedVersion: 1, reason: 'damaged', receiptDepletion: 'available-locations' };
      assert.deepEqual(await legacy.receipts.return(injected), { ok: false, error: { kind: 'InsufficientStock' } });
      assert.deepEqual(snapshot(disk.repository), initial);
      const mutable = { ...policy }, warehouse = factory(disk.repository, actor('warehouse'), mutable);
      mutable.receiptDepletion = 'receiving-only'; // host configuration is owned at construction
      const corrected = success(await warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 1 }] }));
      assert.equal(corrected.state, 'accepted'); assert.equal(corrected.version, 2);
      const stock = success(disk.repository.read('stock', 'warehouse', actor('warehouse')));
      const at = (sku: string, location: string) => stock.positions.find(row => row.sku === sku && row.location === location);
      assert.deepEqual(at('a', 'receiving'), { sku: 'a', location: 'receiving', onHand: 0, reserved: 0 });
      assert.deepEqual(at('a', 'alpha'), { sku: 'a', location: 'alpha', onHand: 2, reserved: 2 });
      assert.deepEqual(at('a', 'beta'), { sku: 'a', location: 'beta', onHand: 2, reserved: 0 });
      assert.equal(at('b', 'zeta')?.onHand, 1); assert.equal(stock.version, 7);
      assert.equal(success(disk.repository.read('invoice', 'inv', actor('finance'))).state, 'registered');
      disk.reopen();
      const loaded = await procurementContext(disk.repository, actor('warehouse'), policy).receipt({ id: 'rc', expectedVersion: 2 });
      const composed = await procurementProcessContext(disk.repository, actor('warehouse'), policy).receipt({ id: 'rc', expectedVersion: 2 });
      assert.deepEqual(composed, loaded);
      const expanded = success(await factory(disk.repository, actor('warehouse'), policy).receipts.correct({ id: 'rc', expectedVersion: 2, quantities: [{ sku: 'a', quantity: 3 }, { sku: 'b', quantity: 2 }] }));
      assert.equal(expanded.version, 3);
      const increased = success(disk.repository.read('stock', 'warehouse', actor('warehouse')));
      assert.equal(increased.positions.find(row => row.sku === 'a' && row.location === 'receiving')?.onHand, 1);
      assert.equal(increased.positions.find(row => row.sku === 'b' && row.location === 'receiving')?.onHand, 1);
      const returned = success(await factory(disk.repository, actor('warehouse'), policy).receipts.return({ id: 'rc', expectedVersion: 3, reason: 'remaining units' }));
      assert.equal(returned.state, 'returned'); assert.equal(returned.version, 4);
      const final = success(disk.repository.read('stock', 'warehouse', actor('warehouse')));
      assert.equal(final.version, 9); assert.equal(final.positions.reduce((n, row) => n + row.onHand, 0), 2);
      assert.equal(final.positions.reduce((n, row) => n + row.reserved, 0), 2);
      assert.deepEqual(final.lastAdjustment, stock.lastAdjustment);
      disk.reopen(); assert.deepEqual(success(disk.repository.read('stock', 'warehouse', actor('warehouse'))), final);
      const outcome = { corrected, expanded, returned, models: snapshot(disk.repository) };
      if (outcomes.has(backend)) assert.deepEqual(outcome, outcomes.get(backend)); else outcomes.set(backend, outcome);
    } finally { disk.close(); }
  });
  test(`multi-SKU insufficient free stock changes nothing / ${name} / ${backend}`, async () => {
    const disk = store(backend);
    try {
      await seed(disk.repository, factory);
      const warehouse = factory(disk.repository, actor('warehouse'), policy);
      success(await warehouse.inventory.reserve({ id: 'warehouse', expectedVersion: 6, sku: 'b', location: 'zeta', quantity: 2 }));
      const before = snapshot(disk.repository);
      // SKU a can be depleted; SKU b cannot. No staged a change can leak through.
      assert.deepEqual(await warehouse.receipts.correct({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 1 }] }), { ok: false, error: { kind: 'InsufficientStock' } });
      assert.deepEqual(snapshot(disk.repository), before);
      const invalid = factory(disk.repository, actor('warehouse'), { ...policy, receiptDepletion: 'unrecognized' as Policy['receiptDepletion'] });
      assert.deepEqual(await invalid.receipts.return({ id: 'rc', expectedVersion: 1, reason: 'damaged' }), { ok: false, error: { kind: 'InvalidInput' } });
      assert.deepEqual(snapshot(disk.repository), before);
    } finally { disk.close(); }
  });
}
for (const [name, factory] of Object.entries(factories)) {
  test(`distributed return rolls back all aggregates and survives retry / ${name} / sqlite`, async () => {
    const disk = store('sqlite');
    try {
      await seed(disk.repository, factory); const before = snapshot(disk.repository);
      const admin = new DatabaseSync(disk.path);
      try { admin.exec("CREATE TRIGGER reject_return_stock BEFORE UPDATE ON procurement WHEN NEW.kind = 'stock' BEGIN SELECT RAISE(ABORT, 'DistributedStockFailure'); END;"); } finally { admin.close(); }
      await assert.rejects(factory(disk.repository, actor('warehouse'), policy).receipts.return({ id: 'rc', expectedVersion: 1, reason: 'damaged' }), /DistributedStockFailure/);
      assert.deepEqual(snapshot(disk.repository), before); disk.reopen(); assert.deepEqual(snapshot(disk.repository), before);
      const repair = new DatabaseSync(disk.path); try { repair.exec('DROP TRIGGER reject_return_stock'); } finally { repair.close(); }
      success(await factory(disk.repository, actor('warehouse'), policy).receipts.return({ id: 'rc', expectedVersion: 1, reason: 'damaged' }));
      assert.equal(success(disk.repository.read('invoice', 'inv', actor('finance'))).state, 'registered');
    } finally { disk.close(); }
  });
  test(`stale distributed return cannot overwrite a concurrent reservation / ${name} / sqlite`, async () => {
    const disk = store('sqlite'); let second: SqliteProcurement | undefined;
    try {
      await seed(disk.repository, factory);
      const loaded = success(await procurementContext(disk.repository, actor('warehouse'), policy).receipt({ id: 'rc', expectedVersion: 1, reason: 'damaged' }));
      const change = success(returnFromStock(loaded));
      second = new SqliteProcurement(disk.path, 'g1');
      success(await factory(second, actor('warehouse'), policy).inventory.reserve({ id: 'warehouse', expectedVersion: 6, sku: 'a', location: 'beta', quantity: 1 }));
      const before = snapshot(disk.repository);
      assert.deepEqual(await disk.repository.commit(change, actor('warehouse')), { ok: false, error: { kind: 'Conflict' } });
      assert.deepEqual(snapshot(disk.repository), before);
      assert.deepEqual(await factory(disk.repository, actor('warehouse'), policy).receipts.return({ id: 'rc', expectedVersion: 1, reason: 'damaged' }), { ok: false, error: { kind: 'InsufficientStock' } });
      success(await factory(second, actor('warehouse'), policy).inventory.release({ id: 'warehouse', expectedVersion: 7, sku: 'a', location: 'beta', quantity: 1 }));
      success(await factory(disk.repository, actor('warehouse'), policy).receipts.return({ id: 'rc', expectedVersion: 1, reason: 'damaged' }));
    } finally { second?.close(); disk.close(); }
  });
}

for (const name of ['koyuki', 'plain', 'helper'] as const) {
  test(`distributed correction receipt keeps original result across policy change / ${name}`, async () => {
    const disk = store('sqlite');
    const commands = (configuration: Policy) => {
      assert(disk.repository instanceof SqliteProcurement);
      return name === 'koyuki' ? procurementReplay(disk.repository, actor('warehouse'), configuration)
        : baselineReplay(name, disk.repository, actor('warehouse'), configuration);
    };
    try {
      await seed(disk.repository, factories[name]);
      const call = { requestId: 'correct', input: { id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 1 }] } };
      const first = success(await commands(policy).receipts.correct.run(call));
      assert.equal(first.kind, 'committed'); assert.equal(first.value.result.state, 'accepted');
      disk.reopen();
      const returned = success(await commands(policy).receipts.return.run({ requestId: 'return', input: { id: 'rc', expectedVersion: 2, reason: 'remaining units' } }));
      assert.equal(returned.value.result.state, 'returned'); disk.reopen();
      const before = snapshot(disk.repository);
      const replay = await commands({ ...policy, receiptDepletion: 'receiving-only' }).receipts.correct.runDetailed(call);
      const value = success(replay.result); assert.equal(value.kind, 'replayed');
      assert.deepEqual(value.value, first.value); assert.equal(replay.attempt, null);
      assert.deepEqual(snapshot(disk.repository), before);
      assert.equal(success(disk.repository.read('receipt', 'rc', actor('warehouse'))).state, 'returned');
    } finally { disk.close(); }
  });
}

test('detailed composed loader carries the trusted depletion policy into the same receipt rule', async () => {
  const repository = new MemoryProcurement(); await seed(repository, procurement);
  const configuration = { detailedLoad: true, receiptDepletion: 'available-locations' as const };
  const api = procurementComposedReads(repository, actor('warehouse'), configuration);
  const report = await api.receipts.correct.runDetailed({ id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 1 }] });
  assert(report.result.ok); assert.equal(report.result.value.version, 2);
  assert.deepEqual(report.trace.map(row => row.step), ['read-receipt', 'read-order', 'read-stock', 'read-related', 'procurement.receipt.v1.correct:load', 'run:1', 'procurement.receipt.v1.correct']);
  const stock = success(repository.read('stock', 'warehouse', actor('warehouse')));
  assert.deepEqual(stock.positions.find(row => row.sku === 'a' && row.location === 'alpha'), { sku: 'a', location: 'alpha', onHand: 2, reserved: 2 });
});
