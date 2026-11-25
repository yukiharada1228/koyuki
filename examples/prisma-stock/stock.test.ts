import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ok, err } from 'koyuki';
import { connect } from './client.js';
import { moveStock, stockMovement } from './application.js';
import { inTransaction } from './transaction.js';
import { move, type Stock } from './domain.js';
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-prisma-')), path = join(dir, 'stock.sqlite');
  let client = connect(path);
  t.after(async () => { await client.$disconnect(); rmSync(dir, { recursive: true, force: true }); });
  const migration = readFileSync(new URL('./prisma/migrations/20261125000000_init/migration.sql', import.meta.url), 'utf8');
  for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await client.$executeRawUnsafe(sql);
  await client.stock.createMany({ data: [{ id: 'source', units: 10, version: 1 }, { id: 'target', units: 2, version: 1 }] });
  return { path, createClient: () => connect(path), get client() { return client; }, async restart() { await client.$disconnect(); client = connect(path); } };
}
const input = { requestId: 'one', source: 'source', target: 'target', units: 3, sourceVersion: 1, targetVersion: 1 };
const quantities = (client: ReturnType<typeof connect>) => client.stock.findMany({ orderBy: { id: 'asc' }, select: { id: true, units: true, version: true } });
const initial = [{ id: 'source', units: 10, version: 1 }, { id: 'target', units: 2, version: 1 }];
test('declared pure movement commits two stocks and history within a Prisma transaction', async t => {
  const f = await fixture(t), result = await moveStock(f.createClient, input); assert(result.ok);
  assert.deepEqual(await quantities(f.client), [{ id: 'source', units: 7, version: 2 }, { id: 'target', units: 5, version: 2 }]);
  assert.equal((await quantities(f.client)).reduce((n, stock) => n + stock.units, 0), 12);
  assert.deepEqual(await f.client.movement.findUnique({ where: { id: 'one' } }), result.value);
  await f.restart(); assert.equal(await f.client.movement.count(), 1);
  assert.equal((await f.client.stock.findUniqueOrThrow({ where: { id: 'source' } })).units, 7);
});
test('plain Prisma commits an Err return, while the Result adapter rolls prior writes back', async t => {
  const f = await fixture(t);
  const ordinary = await f.client.$transaction(async tx => { await tx.stock.update({ where: { id: 'source' }, data: { units: 9 } }); return err('Rejected'); });
  assert.deepEqual(ordinary, err('Rejected')); assert.equal((await quantities(f.client))[0]?.units, 9);
  const failure = { kind: 'BusinessRejected' as const };
  const wrapped = await inTransaction(f.createClient, async tx => { await tx.stock.update({ where: { id: 'source' }, data: { units: 8 } }); return err(failure); });
  assert.deepEqual(wrapped, err(failure));
  assert.equal((await quantities(f.client))[0]?.units, 9);
});
test('typed conflict after the first stock update rolls that update back', async t => {
  const f = await fixture(t);
  await f.client.$executeRawUnsafe(`CREATE TRIGGER reject_target BEFORE UPDATE ON "Stock" WHEN OLD.id='target' BEGIN SELECT RAISE(IGNORE); END`);
  assert.deepEqual(await moveStock(f.createClient, input), err({ kind: 'Conflict' }));
  assert.deepEqual(await quantities(f.client), initial); assert.equal(await f.client.movement.count(), 0);
});
test('history insert failure rolls back both prior stock updates', async t => {
  const f = await fixture(t);
  await f.client.$executeRawUnsafe(`CREATE TRIGGER reject_history BEFORE INSERT ON "Movement" BEGIN SELECT RAISE(ABORT,'history unavailable'); END`);
  assert.deepEqual(await moveStock(f.createClient, input), err({ kind: 'StorageUnavailable' }));
  assert.deepEqual(await quantities(f.client), initial); assert.equal(await f.client.movement.count(), 0);
});
test('insufficient stock and stale versions preserve data and history', async t => {
  const f = await fixture(t);
  assert.deepEqual(await moveStock(f.createClient, { ...input, units: 11 }), err({ kind: 'InsufficientStock' }));
  assert.deepEqual(await moveStock(f.createClient, { ...input, sourceVersion: 2 }), err({ kind: 'Conflict' }));
  assert.deepEqual(await quantities(f.client), initial); assert.equal(await f.client.movement.count(), 0);
});
test('duplicate request IDs are rejected before writing a second movement', async t => {
  const f = await fixture(t); assert((await moveStock(f.createClient, input)).ok);
  assert.deepEqual(await moveStock(f.createClient, { ...input, sourceVersion: 2, targetVersion: 2 }), err({ kind: 'DuplicateRequest' }));
  assert.equal(await f.client.movement.count(), 1); assert.equal((await quantities(f.client))[0]?.units, 7);
});
test('unexpected callback defects roll back, propagate and leave the next transaction usable', async t => {
  const f = await fixture(t);
  await assert.rejects(inTransaction(f.createClient, async tx => { await tx.stock.update({ where: { id: 'source' }, data: { units: 0 } }); throw new Error('adapter defect'); }), /adapter defect/);
  assert.deepEqual(await quantities(f.client), initial);
  assert((await moveStock(f.createClient, input)).ok);
});
test('all queries stay bound to the supplied transaction and cannot escape its lifetime', async t => {
  const f = await fixture(t);
  const escaped = await f.client.$transaction(async tx => stockMovement(tx));
  assert.deepEqual(await escaped.run(input), err({ kind: 'StorageUnavailable' }));
  assert.deepEqual(await quantities(f.client), initial);
});
test('short query projection uses Prisma directly without domain restoration or a command', async t => {
  const f = await fixture(t);
  const projected = await f.client.stock.findMany({ select: { id: true, units: true }, orderBy: { id: 'asc' } });
  assert.deepEqual(projected, [{ id: 'source', units: 10 }, { id: 'target', units: 2 }]);
  assert.equal(await f.client.movement.count(), 0);
});
test('missing stock and invalid inputs do not change an existing stock', async t => {
  const f = await fixture(t);
  assert.deepEqual(await moveStock(f.createClient, { ...input, target: 'missing' }), err({ kind: 'NotFound' }));
  assert.deepEqual(await moveStock(f.createClient, { ...input, target: 'source' }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await moveStock(f.createClient, { ...input, units: 0 }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await quantities(f.client), initial);
});
function typeChecks(stock: Stock) {
  // @ts-expect-error unvalidated stock snapshots cannot call domain evolution
  move({ source: stock, target: stock, input });
  // @ts-expect-error transaction context does not offer global-client connection control
  inTransaction(() => connect('unused'), async tx => { await tx.$disconnect(); return ok(null); });
}
void typeChecks;


test('the checked-in migration deploys through the actual Prisma CLI', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-prisma-migration-')), path = join(dir, 'stock.sqlite');
  const client = connect(path);
  t.after(async () => { await client.$disconnect(); rmSync(dir, { recursive: true, force: true }); });
  const migrated = spawnSync(process.execPath, [fileURLToPath(new URL('./node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, DATABASE_URL: `file:${path}` }, encoding: 'utf8',
  });
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  assert.equal(await client.stock.count(), 0); assert.equal(await client.movement.count(), 0);
});

test('a deferred constraint failure at commit is a storage error and restores earlier writes', async t => {
  const f = await fixture(t);
  await f.client.$executeRawUnsafe('CREATE TABLE "CommitGuard" ("stockId" TEXT, FOREIGN KEY("stockId") REFERENCES "Stock"("id") DEFERRABLE INITIALLY DEFERRED)');
  const result = await inTransaction(f.createClient, async tx => {
    await tx.stock.update({ where: { id: 'source' }, data: { units: 0 } });
    await tx.$executeRawUnsafe('INSERT INTO "CommitGuard"("stockId") VALUES (\'missing\')');
    return ok('not yet committed');
  });
  assert.deepEqual(result, err({ kind: 'StorageUnavailable' }));
  assert.deepEqual(await quantities(f.client), initial);
  assert((await moveStock(f.createClient, input)).ok); // no abandoned transaction holds a lock
});
