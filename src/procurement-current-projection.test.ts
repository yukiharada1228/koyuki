import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { procurementCurrentApplication, type CurrentRepository } from './experiments/procurement/current-projection.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { Actor } from './experiments/procurement/domain.js';
const actor = (role: Actor['role']): Actor => ({ id: role, role, groupId: 'g1', active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }] };
const call = { requestId: 'create', input };
function disk() { const directory = mkdtempSync(join(tmpdir(), 'koyuki-current-projection-')); return { path: join(directory, 'study.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; }
function port(repository: SqliteProcurement): CurrentRepository {
  return { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository),
    lookupExecution: repository.lookupExecution.bind(repository), commitExecution: repository.commitExecution.bind(repository), current: repository.current.bind(repository) };
}
test('unknown-commit recovery refreshes the saved entity into an initially empty View', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1'); let commits = 0, refreshes = 0;
  try {
    const uncertain: CurrentRepository = { ...port(repository),
      commitExecution: async (change, identity, request) => { commits++; const saved = await repository.commitExecution(change, identity, request); return saved.ok ? { ok: false, error: { kind: 'CommitUnknown' } } : saved; },
      current: (keys, identity) => { refreshes++; return repository.current(keys, identity); },
    };
    const session = await procurementCurrentApplication(uncertain, actor('buyer'), policy).start();
    await session.dispatch({ type: 'request.create', input: call });
    assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().view.entities[0]?.id, 'rq');
    assert.equal(commits, 1); assert.equal(refreshes, 1); assert.equal(repository.list('request', actor('buyer')).length, 1);
  } finally { repository.close(); store.clean(); }
});
test('replaying an old create refreshes the current submitted model instead of applying historical draft data', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const commands = procurementReplay(repository, actor('buyer'), policy);
    assert((await commands.requests.create.run(call)).ok);
    assert((await commands.requests.submit.run({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } })).ok);
    const session = await procurementCurrentApplication(repository, actor('buyer'), policy).start();
    await session.dispatch({ type: 'request.create', input: call });
    const request = session.snapshot().view.entities[0]; assert(request?.kind === 'request'); assert.equal(request.state, 'submitted'); assert.equal(request.version, 2);
    const historical = await commands.requests.create.run(call); assert(historical.ok); assert.equal(historical.value.value.result.version, 1);
  } finally { repository.close(); store.clean(); }
});
test('replayed composite changes refresh all affected keys to current versions', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const buyer = procurementReplay(repository, actor('buyer'), policy), boss = procurementReplay(repository, actor('approver'), policy);
    const warehouse = procurementReplay(repository, actor('warehouse'), policy), finance = procurementReplay(repository, actor('finance'), policy);
    assert((await buyer.requests.create.run(call)).ok);
    assert((await buyer.requests.submit.run({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } })).ok);
    assert((await boss.requests.approve.run({ requestId: 'approve', input: { id: 'rq', expectedVersion: 2 } })).ok);
    assert((await buyer.orders.place.run({ requestId: 'place', input: { id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' } })).ok);
    assert((await warehouse.receipts.receive.run({ requestId: 'receive', input: { id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 2 }] } })).ok);
    assert((await finance.invoices.register.run({ requestId: 'invoice', input: { id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 1000 } })).ok);
    assert((await finance.invoices.match.run({ requestId: 'match', input: { id: 'inv', expectedVersion: 1 } })).ok);
    const returned = { requestId: 'return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } };
    assert((await warehouse.receipts.return.run(returned)).ok);
    assert((await warehouse.receipts.receive.run({ requestId: 'replace', input: { id: 'po', expectedVersion: 4, receiptId: 'new-rc', quantities: [{ sku: 'a', quantity: 2 }] } })).ok);
    assert((await finance.invoices.match.run({ requestId: 'match-again', input: { id: 'inv', expectedVersion: 3 } })).ok);
    const session = await procurementCurrentApplication(repository, actor('warehouse'), policy).start();
    await session.dispatch({ type: 'receipt.return', input: returned });
    const entities = session.snapshot().view.entities; assert.equal(entities.length, 4);
    const order = entities.find(entity => entity.kind === 'order'); assert.equal(order?.version, 5);
    const invoice = entities.find(entity => entity.kind === 'invoice'); assert(invoice?.kind === 'invoice'); assert.equal(invoice.state, 'matched'); assert.equal(invoice.version, 4);
    const stock = entities.find(entity => entity.kind === 'stock'); assert(stock?.kind === 'stock'); assert.equal(stock.version, 3); assert.equal(stock.positions[0]?.onHand, 2);
    // Current affected keys are a patch, not discovery of all later related entities.
    assert.equal(entities.some(entity => entity.id === 'new-rc'), false);
  } finally { repository.close(); store.clean(); }
});
test('refresh failure is distinct from business failure and can be retried without another commit', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1'); let unavailable = true, commits = 0;
  try {
    assert((await procurementReplay(repository, actor('buyer'), policy).requests.create.run(call)).ok);
    const flaky: CurrentRepository = { ...port(repository),
      current: (keys, identity) => unavailable ? { ok: false, error: { kind: 'ProjectionUnavailable' } } : repository.current(keys, identity),
      commitExecution: async (change, identity, request) => { commits++; return repository.commitExecution(change, identity, request); },
    };
    const original = repository.read('request', 'rq', actor('buyer')); assert(original.ok);
    const session = await procurementCurrentApplication(flaky, actor('buyer'), policy, [original.value]).start();
    await session.dispatch({ type: 'request.create', input: call });
    assert.equal(session.snapshot().state.kind, 'failed'); assert.equal(session.snapshot().view.error, 'ProjectionUnavailable'); assert.deepEqual(session.snapshot().view.entities, [original.value]);
    unavailable = false; await session.dispatch({ type: 'dismiss' }); await session.dispatch({ type: 'request.create', input: call });
    assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().view.entities.length, 1); assert.equal(commits, 0);
  } finally { repository.close(); store.clean(); }
});
test('current reads are scoped, deduplicated and never publish a partial missing-key patch', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    assert((await procurementReplay(repository, actor('buyer'), policy).requests.create.run(call)).ok);
    const key = { kind: 'request' as const, id: 'rq' };
    assert.deepEqual(repository.current([key], { ...actor('buyer'), groupId: 'foreign' }), { ok: false, error: { kind: 'ProjectionUnavailable' } });
    assert.deepEqual(repository.current([key], { ...actor('buyer'), active: false }), { ok: false, error: { kind: 'ProjectionUnavailable' } });
    assert.deepEqual(repository.current([key, { kind: 'request', id: 'missing' }], actor('buyer')), { ok: false, error: { kind: 'ProjectionUnavailable' } });
    const current = repository.current([key, key], actor('buyer')); assert(current.ok); assert.equal(current.value.length, 1);
  } finally { repository.close(); store.clean(); }
});
test('partial or unexpected refresh outputs are rejected without replacing the existing View', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    assert((await procurementReplay(repository, actor('buyer'), policy).requests.create.run(call)).ok);
    const original = repository.read('request', 'rq', actor('buyer')); assert(original.ok);
    for (const value of [[], [original.value, original.value], [{ ...original.value, id: 'unexpected' }], [{ ...original.value, groupId: 'foreign' }], [{ ...original.value, version: 0 }]]) {
      const partial: CurrentRepository = { ...port(repository), current: () => ({ ok: true, value }) };
      const session = await procurementCurrentApplication(partial, actor('buyer'), policy, [original.value]).start();
      await session.dispatch({ type: 'request.create', input: call });
      assert.equal(session.snapshot().view.error, 'ProjectionUnavailable'); assert.deepEqual(session.snapshot().view.entities, [original.value]);
    }
    const broken: CurrentRepository = { ...port(repository), current: () => { throw new Error('InjectedRefreshDefect'); } };
    const crash = await procurementCurrentApplication(broken, actor('buyer'), policy).start();
    await crash.dispatch({ type: 'request.create', input: call });
    assert.equal(crash.snapshot().state.kind, 'crashed'); assert.deepEqual(crash.snapshot().view.entities, []);
  } finally { repository.close(); store.clean(); }
});

test('corrupt current data rejects restoration and closes the read transaction before a later recovery', async () => {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    assert((await procurementReplay(repository, actor('buyer'), policy).requests.create.run(call)).ok);
    const admin = new DatabaseSync(store.path);
    try { admin.exec("UPDATE procurement SET payload = json_remove(payload, '$.ownerId') WHERE kind = 'request'"); } finally { admin.close(); }
    assert.throws(() => repository.current([{ kind: 'request', id: 'rq' }], actor('buyer')), /CorruptProcurementStorage/);
    const repair = new DatabaseSync(store.path);
    try { repair.exec("UPDATE procurement SET payload = json_set(payload, '$.ownerId', 'buyer') WHERE kind = 'request'"); } finally { repair.close(); }
    const restored = repository.current([{ kind: 'request', id: 'rq' }], actor('buyer')); assert(restored.ok); assert.equal(restored.value.length, 1);
  } finally { repository.close(); store.clean(); }
});
if (false) {
  const session = await procurementCurrentApplication(null as unknown as CurrentRepository, actor('buyer'), policy).start();
  // @ts-expect-error refresh does not erase the namespaced operation's request contract
  session.dispatch({ type: 'request.create', input: { input } });
}
