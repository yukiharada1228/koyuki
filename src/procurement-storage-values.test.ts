import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err } from './framework/index.js';
import type { Actor, Change, Entity, Position, Stock } from './experiments/procurement/domain.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { prepareReplay } from './experiments/procurement/replay-identity.js';
import { procurementReplay, type ReplayRepository } from './experiments/procurement/replay.js';
import { baselineReplay } from './experiments/procurement/baseline-replay.js';
import { procurement, type Committed } from './experiments/procurement/application.js';
const actor: Actor = { id: 'warehouse', role: 'warehouse', groupId: 'g1', active: true };
const plain = (): Stock => ({ kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1, positions: [], lastAdjustment: null });
function plan<T extends Entity>(value: T): Change<T> {
  return { result: value, writes: [value], checks: [{ kind: value.kind, id: value.id, groupId: value.groupId, version: null }] };
}
class RichStock implements Stock {
  readonly kind = 'stock'; readonly id = 'warehouse'; readonly groupId = 'g1'; readonly version = 1;
  readonly positions: readonly Position[] = []; readonly lastAdjustment = null;
  #marker = 'preserved';
  marker() { return this.#marker; }
}
const evidence: unique symbol = Symbol('host-evidence');
const snapshot = (repository: MemoryProcurement | SqliteProcurement) =>
  (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor));

for (const backend of ['memory', 'sqlite'] as const) {
  test(`DTO save refuses lossy values before changing storage: ${backend}`, async () => {
    const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
    const symbolic: Stock & { readonly [evidence]: true } = { ...plain(), [evidence]: true };
    const hidden: Stock & { readonly hidden: true } = { ...plain(), hidden: true };
    Object.defineProperty(hidden, 'hidden', { enumerable: false });
    let gets = 0;
    const accessor = { ...plain(), get metadata() { gets++; return 'not data'; } };
    const cyclic: Stock & { cycle?: unknown } = { ...plain() }; cyclic.cycle = cyclic;
    const extraPositions: Position[] & { metadata?: string } = []; extraPositions.metadata = 'array metadata';
    const nested: Stock = { ...plain(), positions: extraPositions };
    try {
      const richCommit = repository.commit(plan(new RichStock()), actor);
      type SavedClass = Extract<Awaited<typeof richCommit>, { ok: true }>['value'];
      const typedMarker = (value: SavedClass): string => value.marker();
      void typedMarker; // The ordinary generic signature accepts this class without a cast.
      await assert.rejects(richCommit, { name: 'DataCloneError' });
      assert.deepEqual(snapshot(repository), []);
      for (const value of [symbolic, hidden, accessor, cyclic, nested]) {
        const before = snapshot(repository);
        await assert.rejects(repository.commit(plan(value), actor), { name: 'DataCloneError' });
        assert.deepEqual(snapshot(repository), before);
      }
      // Check write values too, even when the returned result is plain.
      await assert.rejects(repository.commit({ ...plan(plain()), writes: [new RichStock()] }, actor), { name: 'DataCloneError' });
      assert.deepEqual(snapshot(repository), []); assert.equal(gets, 0);
    } finally { if (repository instanceof SqliteProcurement) repository.close(); }
  });

  test(`DTO save preserves supported literal refinements and owned snapshots: ${backend}`, async () => {
    const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
    const positions: Position[] = [{ sku: 'a', location: 'receiving', onHand: 2, reserved: 0 }];
    const value: Stock & { readonly id: 'warehouse'; readonly version: 1 } = { ...plain(), id: 'warehouse', version: 1, positions };
    try {
      const saved = await repository.commit(plan(value), actor); assert(saved.ok);
      const id: 'warehouse' = saved.value.id, version: 1 = saved.value.version;
      assert.equal(id, 'warehouse'); assert.equal(version, 1);
      assert.deepEqual(saved.value, value); assert.notStrictEqual(saved.value, value); assert.notStrictEqual(saved.value.positions, positions);
      positions.push({ sku: 'b', location: 'receiving', onHand: 1, reserved: 0 });
      Reflect.set(saved.value.positions[0]!, 'onHand', 99);
      const stored = repository.read('stock', 'warehouse', actor); assert(stored.ok);
      assert.deepEqual(stored.value.positions, [{ sku: 'a', location: 'receiving', onHand: 2, reserved: 0 }]);
    } finally { if (repository instanceof SqliteProcurement) repository.close(); }
  });
}

test('lossy DTO values do not create a SQLite replay receipt', async () => {
  const repository = new SqliteProcurement(':memory:', 'g1');
  try {
    const request = await prepareReplay('initial-stock', 'stock.create.v1', { id: 'warehouse' }, actor); assert(request.ok);
    const value: Stock & { readonly [evidence]: true } = { ...plain(), [evidence]: true };
    const change = { ...plan(value), writes: [plain()] };
    await assert.rejects(repository.commitExecution(change, actor, request.value), { name: 'DataCloneError' });
    assert.deepEqual(repository.lookupExecution(request.value, actor), ok({ kind: 'missing' }));
    assert.deepEqual(snapshot(repository), []);
  } finally { repository.close(); }
});

test('core business still passes opaque domain classes to an adapter that preserves them', async () => {
  const value = new RichStock();
  const commands = business({ name: 'opaque-stock', load: async (_: string) => ok(value),
    save: async (stock: RichStock) => ok(stock), operations: { keep: [(stock: RichStock) => ok(stock)] },
  });
  const saved = await commands.keep('warehouse'); assert(saved.ok);
  assert.strictEqual(saved.value, value); assert.equal(saved.value.marker(), 'preserved');
});

test('fresh commits retain literal refinements while historical results cannot borrow the current version', async () => {
  const repository = new SqliteProcurement(':memory:', 'g1');
  try {
    const request = await prepareReplay('initial-stock', 'stock.create.v1', { id: 'warehouse' }, actor); assert(request.ok);
    const initial: Stock & { readonly version: 1 } = { ...plain(), version: 1 };
    const first = await repository.commitExecution(plan(initial), actor, request.value); assert(first.ok && first.value.kind === 'committed');
    const version: 1 = first.value.value.result.version; assert.equal(version, 1);
    const current: Stock & { readonly version: 2 } = { ...plain(), version: 2 };
    const replayed = await repository.commitExecution({ result: current, writes: [current],
      checks: [{ kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1 }],
    }, actor, request.value);
    assert(replayed.ok && replayed.value.kind === 'replayed'); assert.equal(replayed.value.value.result.version, 1);
    if (false) {
      // @ts-expect-error the historical value is not proved to have the new decision's literal version
      const incorrect: 2 = replayed.value.value.result.version;
      void incorrect;
    }
  } finally { repository.close(); }
});

const policy = { requestLimitCents: 2000, approverIds: ['boss', 'other'] };
const buyer: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const builders = {
  koyuki: (repository: ReplayRepository) => procurementReplay(repository, buyer, policy),
  plain: (repository: ReplayRepository) => baselineReplay('plain', repository, buyer, policy),
  helper: (repository: ReplayRepository) => baselineReplay('helper', repository, buyer, policy),
};
test('public replay boundaries reject a different model in lookup and concurrent commit history', async () => {
  for (const build of Object.values(builders)) for (const phase of ['lookup', 'commit', 'resolution']) {
    const memory = new MemoryProcurement(); let commits = 0, lookups = 0;
    const wrong: Committed = { result: plain(), writes: [plain()] };
    const replayed = { kind: 'replayed' as const, value: wrong };
    const repository: ReplayRepository = {
      read: memory.read.bind(memory), related: memory.related.bind(memory), commit: memory.commit.bind(memory),
      lookupExecution: async () => {
        lookups++;
        return phase === 'lookup' || phase === 'resolution' && lookups > 1 ? ok({ kind: 'found' as const, value: wrong }) : ok({ kind: 'missing' as const });
      },
      commitExecution: async () => { commits++; return phase === 'resolution' ? err({ kind: 'CommitUnknown' as const }) : ok(replayed); },
    };
    await assert.rejects(build(repository).requests.create.run({ requestId: 'create', input: {
      id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }],
    } }), /UnexpectedProcurementExecutionKind/);
    assert.equal(commits, phase === 'lookup' ? 0 : 1); assert.deepEqual(snapshot(memory), []);
    assert.equal(lookups, phase === 'resolution' ? 2 : 1);
  }
});

test('a concurrent replay publishes the historical model and writes rather than the typed current acknowledgement', async () => {
  for (const build of Object.values(builders)) {
    const repository = new SqliteProcurement(':memory:', 'g1');
    try {
      const winner = procurementReplay(repository, buyer, { ...policy, secondApproval: { aboveCents: 500, approverId: 'other' } });
      assert((await procurement(repository, buyer, policy).requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }] })).ok);
      const old = repository.read('request', 'rq', buyer); assert(old.ok);
      const call = { requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'boss' } };
      const committed = await winner.requests.submit.run(call); assert(committed.ok);
      assert.equal(committed.value.value.result.state, 'first-review');
      const snapshotReader = new MemoryProcurement([old.value]); let commits = 0;
      // A missing lookup and older read snapshot model a losing attempt. Atomic
      // commitExecution still returns the real winner from SQLite.
      const stale: ReplayRepository = {
        read: snapshotReader.read.bind(snapshotReader), related: snapshotReader.related.bind(snapshotReader),
        commit: repository.commit.bind(repository), lookupExecution: async () => ok({ kind: 'missing' }),
        commitExecution: (change, identity, request) => { commits++; return repository.commitExecution(change, identity, request); },
      };
      const report = await build(stale).requests.submit.runDetailed(call); assert(report.result.ok);
      assert.equal(report.result.value.kind, 'replayed'); assert.equal(commits, 1);
      assert.deepEqual(report.result.value.value, committed.value.value);
      assert.equal(report.result.value.value.result.state, 'first-review');
      const candidate = report.attempt?.plan; assert(candidate && typeof candidate === 'object' && 'input' in candidate);
      const proposed = candidate.input; assert(proposed && typeof proposed === 'object' && 'result' in proposed);
      const proposedResult = proposed.result; assert(proposedResult && typeof proposedResult === 'object' && 'state' in proposedResult);
      assert.equal(proposedResult.state, 'submitted'); // A plan is not the winner's persisted history.
      const current = repository.read('request', 'rq', buyer); assert(current.ok);
      assert.deepEqual(current.value, committed.value.value.result);
    } finally { repository.close(); }
  }
});
