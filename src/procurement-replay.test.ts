import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { withReplay, err, type Execution, type Result } from './framework/index.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { prepareReplay, type ReplayError } from './experiments/procurement/replay-identity.js';
import { createRequest, type Actor, type CreateInput, type RuleError } from './experiments/procurement/domain.js';
import { procurementReplay, type ReplayRepository } from './experiments/procurement/replay.js';
import { procurementReplayApplication } from './experiments/procurement/projection.js';
import { procurement, type Committed } from './experiments/procurement/application.js';
import type { StorageError } from './experiments/procurement/repository.js';
const actor: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }] };
function store() { const directory = mkdtempSync(join(tmpdir(), 'koyuki-replay-db-')); return { path: join(directory, 'data.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; }
test('replay identity canonically binds input, actor and operation using Web Crypto', async () => {
  const first = await prepareReplay('call', 'request.create.v1', input, actor); assert(first.ok);
  const reordered = await prepareReplay('call', 'request.create.v1', { lines: [{ unitCents: 500, quantity: 2, sku: 'a' }], id: 'rq' }, actor); assert(reordered.ok);
  assert.equal(first.value.fingerprint, reordered.value.fingerprint);
  for (const changed of [await prepareReplay('call', 'request.create.v2', input, actor), await prepareReplay('call', 'request.create.v1', { ...input, id: 'different' }, actor), await prepareReplay('call', 'request.create.v1', input, { ...actor, id: 'other' })]) {
    assert(changed.ok); assert.notEqual(changed.value.fingerprint, first.value.fingerprint);
  }
  for (const invalid of [undefined, NaN, new Date(), { field: undefined }, new Array(1), { fn: () => 1 }]) assert.deepEqual(await prepareReplay('call', 'request.create.v1', invalid, actor), err({ kind: 'InvalidReplayRequest' }));
  assert.deepEqual(await prepareReplay('call', 'request.create.v1', input, { ...actor, active: false }), err({ kind: 'Denied' }));
});
test('receipt persists with the model and remains historical after newer state and database reopen', async () => {
  const disk = store(); let repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const identity = await prepareReplay('call', 'request.create.v1', input, actor); assert(identity.ok);
    const change = createRequest({ input, actor }); assert(change.ok);
    const result = await repository.commitExecution(change.value, actor, identity.value); assert(result.ok); assert.equal(result.value.kind, 'committed');
    assert((await procurement(repository, actor, { requestLimitCents: 1000, approverIds: ['approver'] }).requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
    repository.close(); repository = new SqliteProcurement(disk.path, 'g1');
    const cached = repository.lookupExecution(identity.value, actor); assert(cached.ok && cached.value.kind === 'found'); assert.equal(cached.value.value.result.version, 1);
    const current = repository.read('request', 'rq', actor); assert(current.ok); assert.equal(current.value.version, 2);
    assert.deepEqual(repository.lookupExecution(identity.value, { ...actor, active: false }), err({ kind: 'Denied' }));
    assert.deepEqual(repository.lookupExecution(identity.value, { ...actor, groupId: 'foreign' }), err({ kind: 'Denied' }));
    assert.deepEqual(repository.lookupExecution(identity.value, { ...actor, id: 'other' }), err({ kind: 'ReplayMismatch' }));
    const changed = await prepareReplay('call', 'request.create.v1', { ...input, id: 'other' }, actor); assert(changed.ok);
    assert.deepEqual(repository.lookupExecution(changed.value, actor), err({ kind: 'ReplayMismatch' }));
    assert.deepEqual(repository.lookupExecution({ ...identity.value, operation: 'request.edit.v1' }, actor), err({ kind: 'ReplayMismatch' }));
  } finally { repository.close(); disk.clean(); }
});
test('failure inserting the execution receipt rolls back the model; retry can then commit once', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const identity = await prepareReplay('call', 'request.create.v1', input, actor); assert(identity.ok);
    const change = createRequest({ input, actor }); assert(change.ok);
    const admin = new DatabaseSync(disk.path);
    try { admin.exec("CREATE TRIGGER reject_execution BEFORE INSERT ON procurement_executions BEGIN SELECT RAISE(ABORT, 'InjectedReceiptFailure'); END;"); } finally { admin.close(); }
    await assert.rejects(repository.commitExecution(change.value, actor, identity.value), /InjectedReceiptFailure/);
    assert.deepEqual(repository.read('request', 'rq', actor), err({ kind: 'NotFound' }));
    assert.deepEqual(repository.lookupExecution(identity.value, actor), { ok: true, value: { kind: 'missing' } });
    const repair = new DatabaseSync(disk.path); try { repair.exec('DROP TRIGGER reject_execution'); } finally { repair.close(); }
    const result = await repository.commitExecution(change.value, actor, identity.value); assert(result.ok); assert.equal(result.value.kind, 'committed');
  } finally { repository.close(); disk.clean(); }
});
test('two connections committing the same request yield one commit and one historical execution', async () => {
  const disk = store(), first = new SqliteProcurement(disk.path, 'g1'), second = new SqliteProcurement(disk.path, 'g1');
  try {
    const identity = await prepareReplay('call', 'request.create.v1', input, actor); assert(identity.ok);
    const change = createRequest({ input, actor }); assert(change.ok);
    const results = await Promise.all([first.commitExecution(change.value, actor, identity.value), second.commitExecution(change.value, actor, identity.value)]);
    assert(results.every(result => result.ok)); assert.deepEqual(results.map(result => result.ok ? result.value.kind : null).sort(), ['committed', 'replayed']);
    assert.equal(first.list('request', actor).length, 1);
  } finally { first.close(); second.close(); disk.clean(); }
});
test('existing withReplay resolves a lost successful response by receipt without retrying the command', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1'); let calls = 0;
  type Call = { requestId: string; input: CreateInput };
  type Failure = RuleError | StorageError | ReplayError | { kind: 'CommitUnknown' };
  try {
    const command = withReplay({ run: async (call: Call): Promise<Result<Execution<Committed>, Failure>> => {
      calls++;
      const identity = await prepareReplay(call.requestId, 'request.create.v1', call.input, actor); if (!identity.ok) return identity;
      const change = createRequest({ input: call.input, actor }); if (!change.ok) return change;
      const saved = await repository.commitExecution(change.value, actor, identity.value);
      return saved.ok ? err({ kind: 'CommitUnknown' }) : saved;
    } }, { lookup: async (call: Call) => {
      const identity = await prepareReplay(call.requestId, 'request.create.v1', call.input, actor);
      return identity.ok ? repository.lookupExecution(identity.value, actor) : identity;
    }, resolveAfter: error => error.kind === 'CommitUnknown' || error.kind === 'Conflict' });
    const call = { requestId: 'call', input };
    const first = await command.run(call); assert(first.ok); assert.equal(first.value.kind, 'replayed'); assert.equal(calls, 1);
    const second = await command.runDetailed(call); assert(second.result.ok); assert.equal(second.attempt, null); assert.equal(calls, 1);
    assert.deepEqual(await command.run({ requestId: 'call', input: { ...input, id: 'other' } }), err({ kind: 'ReplayMismatch' })); assert.equal(calls, 1);
  } finally { repository.close(); disk.clean(); }
});
test('corrupt execution payloads fail closed rather than being replayed or treated as missing', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const identity = await prepareReplay('call', 'request.create.v1', input, actor); assert(identity.ok);
    const change = createRequest({ input, actor }); assert(change.ok); assert((await repository.commitExecution(change.value, actor, identity.value)).ok);
    const admin = new DatabaseSync(disk.path); try { admin.exec("UPDATE procurement_executions SET payload = json_set(payload, '$.result.state', 'approved')"); } finally { admin.close(); }
    assert.throws(() => repository.lookupExecution(identity.value, actor), /CorruptProcurementExecution/);
  } finally { repository.close(); disk.clean(); }
});


test('all 25 replay commands reuse business declarations, preserve detail, and skip historical work', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const commands = procurementReplay(repository, actor, { requestLimitCents: 1000, approverIds: ['approver'] });
    assert.equal(Object.values(commands).reduce((sum, table) => sum + Object.keys(table).length, 0), 25);
    const call = { requestId: 'create', input };
    const first = await commands.requests.create.runDetailed(call); assert(first.result.ok); assert.equal(first.result.value.kind, 'committed'); assert(first.attempt?.trace?.length);
    assert((await commands.requests.submit.run({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } })).ok);
    const historical = await commands.requests.create.runDetailed(call); assert(historical.result.ok); assert.equal(historical.result.value.kind, 'replayed'); assert.equal(historical.attempt, null);
    assert.equal(historical.result.value.value.result.version, 1);
    assert.deepEqual(await commands.requests.edit.run({ requestId: 'create', input: { id: 'rq', expectedVersion: 2, lines: input.lines } }), err({ kind: 'ReplayMismatch' }));
    const disabled = procurementReplay(repository, { ...actor, active: false }, { requestLimitCents: 1000, approverIds: ['approver'] });
    assert.deepEqual(await disabled.requests.create.run(call), err({ kind: 'Denied' }));
    if (false) {
      // @ts-expect-error execution identity is required separately from the domain input
      commands.requests.create.run({ input });
      // @ts-expect-error operation-specific fields remain required inside the call
      commands.receipts.receive.run({ requestId: 'receive', input: { id: 'po', expectedVersion: 1, receiptId: 'rc' } });
    }
  } finally { repository.close(); disk.clean(); }
});
test('replay Application keeps newer projection and does not hydrate an empty view from historical output', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
    const session = await procurementReplayApplication(repository, actor, policy).start();
    const create = { requestId: 'create', input };
    await session.dispatch({ type: 'request.create', input: create });
    await session.dispatch({ type: 'request.submit', input: { requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } } });
    assert.equal(session.snapshot().view.entities[0]?.version, 2);
    await session.dispatch({ type: 'request.create', input: create });
    assert.equal(session.snapshot().view.entities[0]?.version, 2);
    const empty = await procurementReplayApplication(repository, actor, policy).start();
    await empty.dispatch({ type: 'request.create', input: create });
    assert.deepEqual(empty.snapshot().view.entities, []);
  } finally { repository.close(); disk.clean(); }
});
test('concurrent replay calls produce one new commit and historical results for every duplicate', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const commands = procurementReplay(repository, actor, { requestLimitCents: 1000, approverIds: ['approver'] });
    const results = await Promise.all(Array.from({ length: 8 }, () => commands.requests.create.run({ requestId: 'same-call', input })));
    assert(results.every(result => result.ok));
    assert.equal(results.filter(result => result.ok && result.value.kind === 'committed').length, 1);
    assert.equal(repository.list('request', actor).length, 1);
  } finally { repository.close(); disk.clean(); }
});
test('all-command boundary resolves an explicitly classified unknown commit without rerunning domain work', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1'); let commits = 0;
  try {
    const unknown: ReplayRepository = {
      read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository), lookupExecution: repository.lookupExecution.bind(repository),
      commitExecution: async (change, identityActor, identity) => {
        commits++; const saved = await repository.commitExecution(change, identityActor, identity);
        return saved.ok ? err({ kind: 'CommitUnknown' }) : saved;
      },
    };
    const command = procurementReplay(unknown, actor, { requestLimitCents: 1000, approverIds: ['approver'] }).requests.create;
    const result = await command.run({ requestId: 'call', input }); assert(result.ok); assert.equal(result.value.kind, 'replayed'); assert.equal(commits, 1);
  } finally { repository.close(); disk.clean(); }
});

test('replay commands atomically save receipt, order, invoice and stock together with their execution receipt', async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  try {
    const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
    const buyer = procurementReplay(repository, actor, policy);
    const boss = procurementReplay(repository, { ...actor, id: 'approver', role: 'approver' }, policy);
    const warehouseActor: Actor = { ...actor, id: 'warehouse', role: 'warehouse' };
    const warehouse = procurementReplay(repository, warehouseActor, policy);
    const finance = procurementReplay(repository, { ...actor, id: 'finance', role: 'finance' }, policy);
    assert((await buyer.requests.create.run({ requestId: 'create', input })).ok);
    assert((await buyer.requests.submit.run({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } })).ok);
    assert((await boss.requests.approve.run({ requestId: 'approve', input: { id: 'rq', expectedVersion: 2 } })).ok);
    assert((await buyer.orders.place.run({ requestId: 'place', input: { id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' } })).ok);
    assert((await warehouse.receipts.receive.run({ requestId: 'receive', input: { id: 'po', expectedVersion: 1, receiptId: 'rc', quantities: [{ sku: 'a', quantity: 2 }] } })).ok);
    assert((await finance.invoices.register.run({ requestId: 'invoice', input: { id: 'po', expectedVersion: 2, invoiceId: 'inv', amountCents: 1000 } })).ok);
    assert((await finance.invoices.match.run({ requestId: 'match', input: { id: 'inv', expectedVersion: 1 } })).ok);
    const call = { requestId: 'return', input: { id: 'rc', expectedVersion: 1, reason: 'defect' } };
    const before = (['order', 'receipt', 'invoice', 'stock'] as const).flatMap(kind => repository.list(kind, warehouseActor));
    const admin = new DatabaseSync(disk.path);
    try { admin.exec("CREATE TRIGGER reject_return_receipt BEFORE INSERT ON procurement_executions WHEN NEW.request_id = 'return' BEGIN SELECT RAISE(ABORT, 'InjectedReturnReceiptFailure'); END;"); } finally { admin.close(); }
    await assert.rejects(warehouse.receipts.return.run(call), /InjectedReturnReceiptFailure/);
    assert.deepEqual((['order', 'receipt', 'invoice', 'stock'] as const).flatMap(kind => repository.list(kind, warehouseActor)), before);
    const identity = await prepareReplay(call.requestId, 'procurement.receipt.v1.return', call.input, warehouseActor); assert(identity.ok);
    assert.deepEqual(repository.lookupExecution(identity.value, warehouseActor), { ok: true, value: { kind: 'missing' } });
    const repair = new DatabaseSync(disk.path); try { repair.exec('DROP TRIGGER reject_return_receipt'); } finally { repair.close(); }
    const result = await warehouse.receipts.return.run(call); assert(result.ok); assert.equal(result.value.kind, 'committed'); assert.equal(result.value.value.writes.length, 4);
    const replay = await warehouse.receipts.return.runDetailed(call); assert(replay.result.ok); assert.equal(replay.result.value.kind, 'replayed'); assert.equal(replay.attempt, null);
    assert.deepEqual(replay.result.value.value, result.value.value);
  } finally { repository.close(); disk.clean(); }
});

test('a racing order that observes an existing order resolves AlreadyExists to the same successful execution', { timeout: 5000 }, async () => {
  const disk = store(), repository = new SqliteProcurement(disk.path, 'g1');
  let releaseLookups: () => void = () => {}, releaseCommit: () => void = () => {};
  const lookupsReady = new Promise<void>(resolve => { releaseLookups = resolve; });
  const commitDone = new Promise<void>(resolve => { releaseCommit = resolve; });
  let lookups = 0, reads = 0, commits = 0;
  try {
    const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
    const buyer = procurement(repository, actor, policy);
    assert((await buyer.requests.create(input)).ok);
    assert((await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' })).ok);
    const boss = procurement(repository, { ...actor, role: 'approver', id: 'approver' }, policy);
    assert((await boss.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
    const gated: ReplayRepository = {
      related: repository.related.bind(repository), commit: repository.commit.bind(repository),
      read: async (kind, id, identityActor) => {
        if (kind === 'request' && ++reads === 2) await commitDone;
        return repository.read(kind, id, identityActor);
      },
      lookupExecution: async (identity, identityActor) => {
        const result = repository.lookupExecution(identity, identityActor);
        if (++lookups <= 2) { if (lookups === 2) releaseLookups(); await lookupsReady; }
        return result;
      },
      commitExecution: async (change, identityActor, identity) => {
        commits++; const result = await repository.commitExecution(change, identityActor, identity); releaseCommit(); return result;
      },
    };
    const command = procurementReplay(gated, actor, policy).orders.place;
    const call = { requestId: 'place', input: { id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' } };
    const reports = await Promise.all([command.runDetailed(call), command.runDetailed(call)]);
    assert(reports.every(report => report.result.ok)); assert.equal(commits, 1);
    assert(reports.some(report => report.attempt && !report.attempt.result.ok && report.attempt.result.error.kind === 'AlreadyExists'));
    assert.equal(reports.filter(report => report.result.ok && report.result.value.kind === 'replayed').length, 1);
  } finally { releaseLookups(); releaseCommit(); repository.close(); disk.clean(); }
});
