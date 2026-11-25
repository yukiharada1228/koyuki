import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { procurementCurrentApplication, type CurrentRepository } from './experiments/procurement/current-projection.js';
import { baselineCurrentApplication } from './experiments/procurement/baseline-application.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { Actor, Entity } from './experiments/procurement/domain.js';
const actor = (role: Actor['role']): Actor => ({ id: role, role, groupId: 'g1', active: true });
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }] };
const call = { requestId: 'create', input };
const builders = {
  koyuki: (repository: CurrentRepository, identity = actor('buyer'), initial: readonly Entity[] = []) => procurementCurrentApplication(repository, identity, policy, initial),
  plain: (repository: CurrentRepository, identity = actor('buyer'), initial: readonly Entity[] = []) => baselineCurrentApplication('plain', repository, identity, policy, initial),
  helper: (repository: CurrentRepository, identity = actor('buyer'), initial: readonly Entity[] = []) => baselineCurrentApplication('helper', repository, identity, policy, initial),
};
type Builder = typeof builders[keyof typeof builders];
function disk() { const directory = mkdtempSync(join(tmpdir(), 'koyuki-current-comparison-')); return { path: join(directory, 'study.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; }
function port(repository: SqliteProcurement): CurrentRepository {
  return { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository),
    lookupExecution: repository.lookupExecution.bind(repository), commitExecution: repository.commitExecution.bind(repository), current: repository.current.bind(repository) };
}
async function unknown(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1'); let commits = 0, reads = 0;
  try {
    const uncertain: CurrentRepository = { ...port(repository),
      commitExecution: async (change, identity, request) => { commits++; const saved = await repository.commitExecution(change, identity, request); return saved.ok ? { ok: false, error: { kind: 'CommitUnknown' } } : saved; },
      current: (keys, identity) => { reads++; return repository.current(keys, identity); },
    };
    const session = await build(uncertain).start(), notifications: unknown[] = [];
    session.subscribe(snapshot => notifications.push(snapshot));
    const first = await session.dispatch({ type: 'request.create', input: call });
    const second = await session.dispatch({ type: 'request.create', input: call });
    assert.equal(commits, 1); assert.equal(reads, 2); assert.equal(session.snapshot().view.entities[0]?.id, 'rq');
    return { first, second, notifications, trace: session.trace(), snapshot: session.snapshot() };
  } finally { repository.close(); store.clean(); }
}
async function invalidAndRecovery(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1'); let commits = 0;
  try {
    const commands = procurementReplay(repository, actor('buyer'), policy);
    const created = await commands.requests.create.run(call); assert(created.ok);
    assert((await commands.requests.submit.run({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } })).ok);
    const current = repository.read('request', 'rq', actor('buyer')); assert(current.ok);
    let response: 'real' | 'unavailable' | 'broken' | readonly Entity[] = 'real';
    const changing: CurrentRepository = { ...port(repository),
      commitExecution: async (change, identity, request) => { commits++; return repository.commitExecution(change, identity, request); },
      current: (keys, identity) => {
        if (response === 'real') return repository.current(keys, identity);
        if (response === 'broken') throw new Error('InjectedCurrentReadFailure');
        return response === 'unavailable' ? { ok: false, error: { kind: 'ProjectionUnavailable' } } : { ok: true, value: response };
      },
    };
    const session = await build(changing, actor('buyer'), [created.value.value.result]).start();
    const reports: unknown[] = [await session.dispatch({ type: 'request.create', input: call })];
    assert.equal(session.snapshot().view.entities[0]?.version, 2);
    for (const invalid of ['unavailable', [], [current.value, current.value], [{ ...current.value, groupId: 'foreign' }], [{ ...current.value, id: 'extra' }], [{ ...current.value, version: 0 }]] as const) {
      response = invalid;
      reports.push(await session.dispatch({ type: 'request.create', input: call }));
      assert.equal(session.snapshot().view.error, 'ProjectionUnavailable'); assert.equal(session.snapshot().view.entities[0]?.version, 2);
      reports.push(await session.dispatch({ type: 'dismiss' }));
    }
    response = 'broken'; reports.push(await session.dispatch({ type: 'request.create', input: call }));
    assert.equal(session.snapshot().state.kind, 'crashed'); reports.push(await session.dispatch({ type: 'dismiss' }));
    response = 'real'; reports.push(await session.dispatch({ type: 'request.create', input: call }));
    assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(commits, 0);
    return { reports, snapshot: session.snapshot(), trace: session.trace() };
  } finally { repository.close(); store.clean(); }
}
async function composite(build: Builder) {
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
    const session = await build(repository, actor('warehouse')).start();
    const result = await session.dispatch({ type: 'receipt.return', input: returned });
    const entities = session.snapshot().view.entities; assert.equal(entities.length, 4);
    assert.equal(entities.find(entity => entity.kind === 'order')?.version, 5);
    assert.equal(entities.find(entity => entity.kind === 'invoice')?.version, 4);
    assert.equal(entities.find(entity => entity.kind === 'stock')?.version, 3);
    assert.equal(entities.some(entity => entity.id === 'new-rc'), false);
    return { result, snapshot: session.snapshot(), trace: session.trace() };
  } finally { repository.close(); store.clean(); }
}
async function queued(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  let release: () => void = () => {}, started: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; }); let reads = 0;
  try {
    assert((await procurementReplay(repository, actor('buyer'), policy).requests.create.run(call)).ok);
    const delayed: CurrentRepository = { ...port(repository), current: async (keys, identity) => { if (++reads === 1) { started(); await gate; } return repository.current(keys, identity); } };
    const session = await build(delayed).start();
    const first = session.dispatch({ type: 'request.create', input: call }); await entered;
    assert.equal(session.snapshot().state.kind, 'running');
    const owned = { ...structuredClone(input), id: 'second' };
    const second = session.dispatch({ type: 'request.create', input: { requestId: 'second', input: owned } });
    const stale = session.dispatch({ type: 'request.create', input: { requestId: 'third', input: { ...input, id: 'third' } } }, 0);
    owned.id = 'changed-after-queue'; release();
    const results = await Promise.all([first, second, stale]);
    assert.deepEqual(results[2], { ok: false, error: { kind: 'StaleRevision' } });
    assert.deepEqual(repository.list('request', actor('buyer')).map(entity => entity.id).sort(), ['rq', 'second']); assert.equal(reads, 1);
    return { results, snapshot: session.snapshot(), trace: session.trace() };
  } finally { release(); repository.close(); store.clean(); }
}
async function committedCrashRecovery(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  let broken = false, commits = 0, reads = 0;
  let refresh: 'unavailable' | 'broken' | 'real' = 'unavailable';
  try {
    const faulty: CurrentRepository = { ...port(repository),
      commitExecution: async (change, identity, request) => {
        commits++;
        const result = await repository.commitExecution(change, identity, request);
        if (broken) throw new Error('CommittedButResponseLost');
        return result;
      },
      current: (keys, identity) => {
        reads++;
        if (refresh === 'broken') throw new Error('CurrentReadCrashed');
        return refresh === 'unavailable' ? { ok: false, error: { kind: 'ProjectionUnavailable' } } : repository.current(keys, identity);
      },
    };
    const session = await build(faulty).start(), notifications: unknown[] = [];
    session.subscribe(snapshot => notifications.push(snapshot));
    await session.dispatch({ type: 'request.create', input: call });
    broken = true;
    const submit = { type: 'request.submit', input: { requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } } } as const;
    await session.dispatch(submit);
    assert.equal(session.snapshot().state.kind, 'crashed');
    assert.equal(session.snapshot().view.error, 'UnexpectedException');
    assert.equal(session.snapshot().view.busy, false);
    assert.equal(session.snapshot().view.entities[0]?.version, 1);
    assert.equal(repository.list('request', actor('buyer'))[0]?.version, 2);
    assert.equal(commits, 2); assert.equal(reads, 0);
    broken = false;
    // Another caller advances the database beyond the historical submit receipt.
    assert((await procurementReplay(repository, actor('buyer'), policy).requests.withdraw.run({ requestId: 'remote-withdraw', input: { id: 'rq', expectedVersion: 2 } })).ok);
    for (const mode of ['unavailable', 'broken', 'real'] as const) {
      await session.dispatch({ type: 'dismiss' });
      refresh = mode;
      await session.dispatch(submit);
      assert.equal(session.snapshot().state.kind, mode === 'real' ? 'ready' : mode === 'broken' ? 'crashed' : 'failed');
      assert.equal(session.snapshot().view.error, mode === 'real' ? null : mode === 'broken' ? 'UnexpectedException' : 'ProjectionUnavailable');
      assert.equal(session.snapshot().view.busy, false);
      assert.equal(session.snapshot().view.entities[0]?.version, mode === 'real' ? 3 : 1);
      assert.equal(repository.list('request', actor('buyer'))[0]?.version, 3);
      assert.equal(commits, 2);
    }
    assert.equal(reads, 3);
    await session.dispatch({ type: 'request.submit', input: { requestId: 'submit-again', input: { id: 'rq', expectedVersion: 3, approverId: 'approver' } } });
    assert.equal(session.snapshot().state.kind, 'ready');
    assert.equal(session.snapshot().view.entities[0]?.version, 4);
    assert.equal(repository.list('request', actor('buyer'))[0]?.version, 4);
    assert.equal(commits, 3); assert.equal(reads, 3);
    return { notifications, snapshot: session.snapshot(), trace: session.trace() };
  } finally { repository.close(); store.clean(); }
}
for (const [name, build] of Object.entries(builders)) {
  test(`current-read Application committed crash, failed refresh and newer state recovery: ${name}`, async () => assert.deepEqual(await committedCrashRecovery(build), await committedCrashRecovery(builders.koyuki)));
  test(`current-read Application unknown commit recovery parity: ${name}`, async () => assert.deepEqual(await unknown(build), await unknown(builders.koyuki)));
  test(`current-read Application invalid patches and recovery parity: ${name}`, async () => assert.deepEqual(await invalidAndRecovery(build), await invalidAndRecovery(builders.koyuki)));
  test(`current-read Application composite current patch parity: ${name}`, async () => assert.deepEqual(await composite(build), await composite(builders.koyuki)));
  test(`current-read Application queue ownership parity: ${name}`, { timeout: 5000 }, async () => assert.deepEqual(await queued(build), await queued(builders.koyuki)));
}
if (false) {
  const session = await builders.helper(null as unknown as CurrentRepository).start();
  // @ts-expect-error current-read policy preserves each operation's required input
  session.dispatch({ type: 'receipt.receive', input: { requestId: 'receive', input: { id: 'po', expectedVersion: 1, receiptId: 'rc' } } });
}
