import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { procurementReplayApplication } from './experiments/procurement/projection.js';
import { baselineApplication } from './experiments/procurement/baseline-application.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { ReplayRepository } from './experiments/procurement/replay.js';
import type { Actor } from './experiments/procurement/domain.js';
const actor: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }] };
const builders = {
  koyuki: (repository: ReplayRepository) => procurementReplayApplication(repository, actor, policy),
  plain: (repository: ReplayRepository) => baselineApplication('plain', repository, actor, policy),
  helper: (repository: ReplayRepository) => baselineApplication('helper', repository, actor, policy),
};
type Builder = typeof builders[keyof typeof builders];
function disk() { const directory = mkdtempSync(join(tmpdir(), 'koyuki-session-comparison-')); return { path: join(directory, 'study.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; }
async function story(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const session = await build(repository).start(), notifications: unknown[] = [], results: unknown[] = [];
    const unsubscribe = session.subscribe(snapshot => notifications.push(snapshot));
    const owned = structuredClone(input);
    const pending = session.dispatch({ type: 'request.create', input: { requestId: 'create', input: owned } });
    owned.id = 'mutated'; owned.lines[0]!.quantity = 9;
    results.push(await pending);
    assert.equal(session.snapshot().view.entities[0]?.id, 'rq');
    results.push(await session.dispatch({ type: 'request.submit', input: { requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } } }));
    results.push(await session.dispatch({ type: 'request.create', input: { requestId: 'create', input } }));
    assert.equal(session.snapshot().view.entities[0]?.version, 2);
    results.push(await session.dispatch({ type: 'request.approve', input: { requestId: 'missing', input: { id: 'missing', expectedVersion: 1 } } }));
    assert.equal(session.snapshot().state.kind, 'failed');
    results.push(await session.dispatch({ type: 'request.create', input: { requestId: 'blocked', input: { ...input, id: 'blocked' } } }));
    results.push(await session.dispatch({ type: 'dismiss' }));
    results.push(await session.dispatch({ type: 'request.create', input: { requestId: 'stale', input: { ...input, id: 'stale' } } }, 0));
    results.push(await session.dispatch(JSON.parse('{"type":"@complete"}')));
    const before = session.snapshot();
    await assert.rejects(session.dispatch({ type: 'request.create', input: { requestId: 'bad', input: { id: 'bad', lines: () => 1 } } }));
    assert.deepEqual(session.snapshot(), before);
    const final = session.snapshot(), trace = session.trace(); unsubscribe();
    assert.equal(final.revision, 9); assert.equal(final.state.kind, 'ready');
    assert.equal(repository.list('request', actor).length, 1);
    return { results, notifications, final, trace };
  } finally { repository.close(); store.clean(); }
}
async function queued(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  let release: () => void = () => {}, started: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  let commits = 0;
  try {
    const delayed: ReplayRepository = {
      read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository), lookupExecution: repository.lookupExecution.bind(repository),
      commitExecution: async (change, identityActor, request) => { if (++commits === 1) { started(); await gate; } return repository.commitExecution(change, identityActor, request); },
    };
    const session = await build(delayed).start(); let initialThrows = 0;
    assert.throws(() => session.subscribe(() => { initialThrows++; throw new Error('InitialListenerFailure'); }), /InitialListenerFailure/);
    session.subscribe(snapshot => { if (snapshot.state.kind === 'running') throw new Error('LaterListenerFailure'); });
    const first = session.dispatch({ type: 'request.create', input: { requestId: 'first', input } }, 0);
    await entered;
    const owned = { ...structuredClone(input), id: 'second' };
    const second = session.dispatch({ type: 'request.create', input: { requestId: 'second', input: owned } });
    const stale = session.dispatch({ type: 'request.create', input: { requestId: 'third', input: { ...input, id: 'third' } } }, 0);
    owned.id = 'changed-after-queue'; release();
    const results = await Promise.all([first, second, stale]);
    assert.deepEqual(results[2], { ok: false, error: { kind: 'StaleRevision' } }); assert.equal(commits, 2); assert.equal(initialThrows, 1);
    assert.deepEqual(repository.list('request', actor).map(row => row.id).sort(), ['rq', 'second']);
    return { results, snapshot: session.snapshot(), trace: session.trace() };
  } finally { release(); repository.close(); store.clean(); }
}
async function defect(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1'); let broken = true;
  try {
    const faulty: ReplayRepository = {
      read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository), lookupExecution: repository.lookupExecution.bind(repository),
      commitExecution: async (change, identityActor, request) => { if (broken) throw new Error('InjectedSessionFailure'); return repository.commitExecution(change, identityActor, request); },
    };
    const session = await build(faulty).start();
    const crashed = await session.dispatch({ type: 'request.create', input: { requestId: 'create', input } });
    assert.equal(session.snapshot().state.kind, 'crashed'); assert.deepEqual(session.snapshot().view.entities, []);
    broken = false; await session.dispatch({ type: 'dismiss' });
    const repaired = await session.dispatch({ type: 'request.create', input: { requestId: 'create', input } });
    assert.equal(session.snapshot().state.kind, 'ready');
    return { crashed, repaired, trace: session.trace() };
  } finally { repository.close(); store.clean(); }
}
async function unknown(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const uncertain: ReplayRepository = {
      read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository), lookupExecution: repository.lookupExecution.bind(repository),
      commitExecution: async (change, identityActor, request) => { const saved = await repository.commitExecution(change, identityActor, request); return saved.ok ? { ok: false, error: { kind: 'CommitUnknown' } } : saved; },
    };
    const session = await build(uncertain).start();
    const result = await session.dispatch({ type: 'request.create', input: { requestId: 'create', input } });
    assert.equal(repository.list('request', actor).length, 1);
    assert.equal(session.snapshot().state.kind, 'ready'); assert.deepEqual(session.snapshot().view.entities, []);
    return { result, trace: session.trace() };
  } finally { repository.close(); store.clean(); }
}
for (const [name, build] of Object.entries(builders)) {
  test(`independent Application lifecycle, snapshots, notifications and replay parity: ${name}`, async () => assert.deepEqual(await story(build), await story(builders.koyuki)));
  test(`independent Application queue ownership, stale revisions and subscriber isolation: ${name}`, { timeout: 5000 }, async () => assert.deepEqual(await queued(build), await queued(builders.koyuki)));
  test(`independent Application crash and explicit recovery: ${name}`, async () => assert.deepEqual(await defect(build), await defect(builders.koyuki)));
  test(`independent Application unknown-commit replay preserves view without automatic hydration: ${name}`, async () => assert.deepEqual(await unknown(build), await unknown(builders.koyuki)));
}
if (false) {
  const session = await builders.helper(null as unknown as ReplayRepository).start();
  // @ts-expect-error independent Application keeps namespaced operation input contracts
  session.dispatch({ type: 'request.submit', input: { requestId: 'submit', input: { id: 'rq', expectedVersion: 1 } } });
}
