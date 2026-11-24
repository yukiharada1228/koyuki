import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { transition, type Result } from 'koyuki';
import { SqliteInventory, type InventoryRepository } from './repository.js';
import { inventoryCommands, reserved } from './application.js';
import { validateReserve, reserve, confirm, type Input, type Loaded, type Confirmed } from './domain.js';
function value<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
const input = (requestId: string, orderId = 'order-1', quantity = 3, sku = 'tea'): Input => ({ requestId, orderId, quantity, sku });
function fixture(t: { after(fn: () => void): void }, stock = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-inventory-')), path = join(dir, 'inventory.sqlite');
  const repository = new SqliteInventory(path); value(repository.seed('tea', stock));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { repository, path, app: inventoryCommands(repository) };
}
function barrier(repositories: readonly InventoryRepository[]): InventoryRepository[] {
  let loaded = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return repositories.map(repository => ({
    receipt: repository.receipt.bind(repository), save: repository.save.bind(repository),
    async load(operation, request) {
      const snapshot = await repository.load(operation, request);
      if (++loaded === repositories.length) release();
      await gate;
      return snapshot;
    },
  }));
}
test('pure reservation transition returns a new immutable state without changing the input', async t => {
  const { repository } = fixture(t);
  const before = value(await repository.load('reserve', input('r1'))), copy = structuredClone(before);
  const change = value(transition(reserved).run(before));
  assert.deepEqual(before, copy); assert.equal(change.next.reservation.kind, 'reserved');
  assert.equal(change.next.stock.reserved, 3); assert(Object.isFrozen(change.next.stock));
  assert.equal(value(repository.stock('tea')).reserved, 0);
});
test('reserve, confirm and cancel preserve inventory accounting', async t => {
  const { repository, app } = fixture(t);
  const held = value(await app.reserve.run(input('reserve')));
  assert.equal(held.stock.onHand, 10); assert.equal(held.stock.reserved, 3);
  const final = value(await app.confirm.run(input('confirm')));
  assert.equal(final.reservation.kind, 'confirmed'); assert.equal(final.stock.onHand, 7); assert.equal(final.stock.reserved, 0);
  value(await app.reserve.run(input('reserve-2', 'order-2', 2)));
  const cancelled = value(await app.cancel.run(input('cancel-2', 'order-2', 2)));
  assert.equal(cancelled.reservation.kind, 'cancelled'); assert.equal(cancelled.stock.onHand, 7); assert.equal(cancelled.stock.reserved, 0);
  assert.equal(value(repository.stock('tea')).version, 5);
});
test('insufficient stock and invalid requests never write stock or receipts', async t => {
  const { repository, app } = fixture(t, 2);
  assert.deepEqual(await app.reserve.run(input('too-many')), { ok: false, error: { kind: 'InsufficientStock', available: 2 } });
  for (const quantity of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await app.reserve.run(input('invalid', 'order', quantity)), { ok: false, error: { kind: 'InvalidInput' } });
  }
  assert.deepEqual(await app.reserve.run(input(' ', 'order', 1)), { ok: false, error: { kind: 'InvalidInput' } });
  assert.equal(value(repository.receipt('reserve', input('too-many'))), null);
  assert.equal(value(repository.stock('tea')).version, 1);
});
test('full available stock may be reserved and cannot be oversold', async t => {
  const { app } = fixture(t, 3);
  assert.equal(value(await app.reserve.run(input('all'))).stock.reserved, 3);
  assert.deepEqual(await app.reserve.run(input('other', 'order-2', 1)), { ok: false, error: { kind: 'InsufficientStock', available: 0 } });
});
test('unreserved and terminal reservations reject illegal transitions', async t => {
  const { app } = fixture(t);
  assert.deepEqual(await app.confirm.run(input('early')), { ok: false, error: { kind: 'InvalidState' } });
  value(await app.reserve.run(input('reserve')));
  assert.deepEqual(await app.reserve.run(input('again')), { ok: false, error: { kind: 'InvalidState' } });
  value(await app.cancel.run(input('cancel')));
  for (const operation of ['confirm', 'reserve', 'cancel'] as const) {
    assert.deepEqual(await app[operation].run(input(`new-${operation}`)), { ok: false, error: { kind: 'InvalidState' } });
  }
});
test('order identity cannot be changed to a different quantity or SKU', async t => {
  const { repository, app } = fixture(t); value(repository.seed('coffee', 20));
  value(await app.reserve.run(input('reserve')));
  assert.deepEqual(await app.confirm.run(input('wrong-quantity', 'order-1', 2)), { ok: false, error: { kind: 'OrderMismatch' } });
  assert.deepEqual(await app.reserve.run(input('wrong-sku', 'order-1', 3, 'coffee')), { ok: false, error: { kind: 'OrderMismatch' } });
});
test('exact retry returns the committed result without advancing versions', async t => {
  const { repository, app } = fixture(t);
  const original = value(await app.reserve.run(input('reserve')));
  assert.deepEqual(value(await app.reserve.run(input('reserve'))), original);
  assert.equal(value(repository.stock('tea')).version, 2);
  value(await app.confirm.run(input('confirm')));
  const stored = value(repository.stock('tea'));
  // Old success is the original response; replay must never write it over current data.
  assert.deepEqual(value(await app.reserve.run(input('reserve'))), original);
  assert.deepEqual(value(repository.stock('tea')), stored);
});
test('reusing a committed key for another operation or payload fails', async t => {
  const { app } = fixture(t); value(await app.reserve.run(input('key')));
  for (const result of [await app.confirm.run(input('key')), await app.cancel.run(input('key')),
    await app.reserve.run(input('key', 'other')), await app.reserve.run(input('key', 'order-1', 2)),
    await app.reserve.run(input('key', 'order-1', 3, 'coffee'))]) {
    assert.deepEqual(result, { ok: false, error: { kind: 'IdempotencyConflict' } });
  }
});
test('caller mutation after dispatch cannot change request identity', async t => {
  const { app } = fixture(t);
  const request = { ...input('key') }, pending = app.reserve.run(request);
  request.quantity = 9; request.requestId = 'changed';
  assert.equal(value(await pending).reservation.quantity, 3);
  assert.equal(value(await app.reserve.run(input('key'))).reservation.quantity, 3);
});
test('independent connections with the same stock snapshot cannot oversell', async t => {
  const { repository, path } = fixture(t, 10), second = new SqliteInventory(path); t.after(() => second.close());
  const [a, b] = barrier([repository, second]).map(inventoryCommands);
  const results = await Promise.all([a!.reserve.run(input('a', 'order-a', 6)), b!.reserve.run(input('b', 'order-b', 6))]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.deepEqual(results.find(x => !x.ok), { ok: false, error: { kind: 'Conflict' } });
  assert.equal(value(repository.stock('tea')).reserved, 6);
  const loser = results[0]!.ok ? input('b', 'order-b', 6) : input('a', 'order-a', 6);
  assert.deepEqual(await inventoryCommands(second).reserve.run(loser), { ok: false, error: { kind: 'InsufficientStock', available: 4 } });
});
test('simultaneous identical requests both return one committed reservation', async t => {
  const { repository, path } = fixture(t), second = new SqliteInventory(path); t.after(() => second.close());
  const [a, b] = barrier([repository, second]).map(inventoryCommands);
  const results = await Promise.all([a!.reserve.run(input('same')), b!.reserve.run(input('same'))]);
  assert.deepEqual(value(results[0]!), value(results[1]!)); assert.equal(value(repository.stock('tea')).version, 2);
});
test('simultaneous different payloads using one key have exactly one winner', async t => {
  const { repository, path } = fixture(t), second = new SqliteInventory(path); t.after(() => second.close());
  const [a, b] = barrier([repository, second]).map(inventoryCommands);
  const results = await Promise.all([a!.reserve.run(input('same', 'a', 2)), b!.reserve.run(input('same', 'b', 3))]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.deepEqual(results.find(x => !x.ok), { ok: false, error: { kind: 'IdempotencyConflict' } });
  assert.equal(value(repository.stock('tea')).version, 2);
});
test('confirm racing cancellation cannot both commit or release stock twice', async t => {
  const { repository, path, app } = fixture(t); value(await app.reserve.run(input('reserve')));
  const second = new SqliteInventory(path); t.after(() => second.close());
  const [a, b] = barrier([repository, second]).map(inventoryCommands);
  const results = await Promise.all([a!.confirm.run(input('confirm')), b!.cancel.run(input('cancel'))]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.deepEqual(results.find(x => !x.ok), { ok: false, error: { kind: 'Conflict' } });
  const stock = value(repository.stock('tea')); assert.equal(stock.reserved, 0);
  assert.equal(stock.onHand, results[0]!.ok ? 7 : 10); assert.equal(stock.version, 3);
});
test('receipt write failure rolls back both stock and reservation', async t => {
  const { repository, path, app } = fixture(t), admin = new DatabaseSync(path); t.after(() => admin.close());
  admin.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  assert.deepEqual(await app.reserve.run(input('retry')), { ok: false, error: { kind: 'StorageUnavailable' } });
  assert.equal(value(repository.stock('tea')).version, 1);
  assert.equal(admin.prepare('SELECT count(*) AS n FROM reservations').get()?.n, 0);
  assert.equal(admin.prepare('SELECT count(*) AS n FROM receipts').get()?.n, 0);
  admin.exec('DROP TRIGGER fail_receipt');
  assert.equal(value(await app.reserve.run(input('retry'))).stock.reserved, 3);
});
test('retry is resolved if another connection commits between receipt check and load', async t => {
  const { repository, path, app } = fixture(t), second = new SqliteInventory(path); t.after(() => second.close());
  let intercepted = false;
  const racing: InventoryRepository = {
    receipt: second.receipt.bind(second), save: second.save.bind(second),
    async load(operation, request) {
      if (!intercepted) { intercepted = true; value(await app.reserve.run(input('race'))); }
      return second.load(operation, request);
    },
  };
  const result = value(await inventoryCommands(racing).reserve.run(input('race')));
  assert.equal(result.reservation.kind, 'reserved'); assert.equal(value(repository.stock('tea')).version, 2);
});
test('receipts survive a fresh process after later confirmation', async t => {
  const { repository, path, app } = fixture(t);
  const original = value(await app.reserve.run(input('reserve'))); value(await app.confirm.run(input('confirm')));
  const code = `import {SqliteInventory} from './repository.ts'; import {inventoryCommands} from './application.ts'; const repo=new SqliteInventory(${JSON.stringify(path)}); try {console.log(JSON.stringify(await inventoryCommands(repo).reserve.run(${JSON.stringify(input('reserve'))})));} finally {repo.close();}`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { ok: true, value: original });
  assert.equal(value(repository.stock('tea')).onHand, 7); assert.equal(value(repository.stock('tea')).reserved, 0);
});
test('corrupt stored accounting and corrupt receipts return typed storage errors', async t => {
  const { path, app } = fixture(t), admin = new DatabaseSync(path); t.after(() => admin.close());
  value(await app.reserve.run(input('reserve')));
  admin.prepare('UPDATE receipts SET result_json=?').run('{broken');
  assert.deepEqual(await app.reserve.run(input('reserve')), { ok: false, error: { kind: 'CorruptInventory' } });
  admin.exec('UPDATE stock SET reserved=0');
  assert.deepEqual(await app.reserve.run(input('other', 'order-2')), { ok: false, error: { kind: 'CorruptInventory' } });
});
test('unsupported future schema is rejected instead of being overwritten', t => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-schema-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite'), admin = new DatabaseSync(path); admin.exec('PRAGMA user_version=2'); admin.close();
  assert.throws(() => new SqliteInventory(path), /UnsupportedInventorySchema/);
});
function typeBoundaries(loaded: Loaded, terminal: Confirmed) {
  // @ts-expect-error unvalidated state cannot directly evolve
  reserve(loaded);
  const checked = validateReserve(loaded);
  if (checked.ok) {
    // @ts-expect-error reserved proof is different from confirmed/cancelled input proof
    confirm(checked.value);
  }
  // @ts-expect-error a terminal state cannot be represented as an unreserved state
  const pending: Loaded & { reservation: { kind: 'unreserved'; version: 0 } } = { ...loaded, reservation: terminal };
  void pending;
}
void typeBoundaries;
