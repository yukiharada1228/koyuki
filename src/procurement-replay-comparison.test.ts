import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { procurementReplay, type ReplayRepository } from './experiments/procurement/replay.js';
import { baselineReplay } from './experiments/procurement/baseline-replay.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { prepareReplay } from './experiments/procurement/replay-identity.js';
import type { Actor } from './experiments/procurement/domain.js';
const actor: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }] };
const builders = {
  koyuki: (repository: ReplayRepository) => procurementReplay(repository, actor, policy),
  plain: (repository: ReplayRepository) => baselineReplay('plain', repository, actor, policy),
  helper: (repository: ReplayRepository) => baselineReplay('helper', repository, actor, policy),
};
type Builder = typeof builders[keyof typeof builders];
function disk() { const directory = mkdtempSync(join(tmpdir(), 'koyuki-replay-comparison-')); return { path: join(directory, 'study.sqlite'), clean: () => rmSync(directory, { recursive: true, force: true }) }; }
async function reports(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
  try {
    const commands = build(repository);
    assert.equal(Object.values(commands).reduce((sum, table) => sum + Object.keys(table).length, 0), 25);
    const call = { requestId: 'create', input };
    const created = await commands.requests.create.runDetailed(call);
    const submitted = await commands.requests.submit.runDetailed({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'approver' } });
    const historical = await commands.requests.create.runDetailed(call);
    assert(historical.result.ok && historical.result.value.kind === 'replayed'); assert.equal(historical.attempt, null);
    assert.equal(historical.result.value.value.result.version, 1);
    const mismatch = await commands.requests.create.runDetailed({ requestId: 'create', input: { ...input, id: 'other' } });
    const missing = await commands.requests.approve.runDetailed({ requestId: 'missing', input: { id: 'missing', expectedVersion: 1 } });
    const conflict = await commands.requests.create.runDetailed({ requestId: 'duplicate', input });
    const uncloneable = await commands.requests.create.runDetailed({ requestId: 'uncloneable', input: { id: 'bad', lines: () => 1 } });
    const invalidDto = await commands.requests.create.runDetailed({ requestId: 'invalid-dto', input: { id: 'bad', lines: NaN } });
    assert.deepEqual(mismatch.result, { ok: false, error: { kind: 'ReplayMismatch' } });
    assert.deepEqual(missing.result, { ok: false, error: { kind: 'NotFound' } });
    assert.deepEqual(conflict.result, { ok: false, error: { kind: 'Conflict' } });
    assert.deepEqual(uncloneable.result, { ok: false, error: { kind: 'ReplayInputNotCloneable' } });
    assert.deepEqual(invalidDto.result, { ok: false, error: { kind: 'InvalidReplayRequest' } });
    const persisted = repository.list('request', actor); assert.equal(persisted.length, 1); assert.equal(persisted[0]?.version, 2);
    return { created, submitted, historical, mismatch, missing, conflict, uncloneable, invalidDto, persisted };
  } finally { repository.close(); store.clean(); }
}
async function unknownReport(build: Builder) {
  const store = disk(), repository = new SqliteProcurement(store.path, 'g1'); let commits = 0;
  try {
    const unknown: ReplayRepository = {
      read: repository.read.bind(repository), related: repository.related.bind(repository), commit: repository.commit.bind(repository), lookupExecution: repository.lookupExecution.bind(repository),
      commitExecution: async (change, identityActor, request) => {
        commits++; const result = await repository.commitExecution(change, identityActor, request);
        return result.ok ? { ok: false, error: { kind: 'CommitUnknown' } } : result;
      },
    };
    const result = await build(unknown).requests.create.runDetailed({ requestId: 'unknown', input });
    assert(result.result.ok && result.result.value.kind === 'replayed'); assert.equal(commits, 1);
    return result;
  } finally { repository.close(); store.clean(); }
}
for (const [name, build] of Object.entries(builders)) {
  test(`independent replay result, trace and plan parity: ${name}`, async () => {
    assert.deepEqual(await reports(build), await reports(builders.koyuki));
    assert.deepEqual(await unknownReport(build), await unknownReport(builders.koyuki));
  });
  test(`independent replay driver preserves atomic receipt rollback and explicit retry: ${name}`, async () => {
    const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
    try {
      const command = build(repository).requests.create;
      const admin = new DatabaseSync(store.path);
      try { admin.exec("CREATE TRIGGER reject_comparison_execution BEFORE INSERT ON procurement_executions BEGIN SELECT RAISE(ABORT, 'InjectedExecutionFailure'); END;"); } finally { admin.close(); }
      const call = { requestId: 'create', input };
      await assert.rejects(command.runDetailed(call), /InjectedExecutionFailure/);
      assert.equal(repository.list('request', actor).length, 0);
      const identity = await prepareReplay('create', 'procurement.request.v1.create', input, actor); assert(identity.ok);
      assert.deepEqual(repository.lookupExecution(identity.value, actor), { ok: true, value: { kind: 'missing' } });
      const repair = new DatabaseSync(store.path); try { repair.exec('DROP TRIGGER reject_comparison_execution'); } finally { repair.close(); }
      const retried = await command.run(call); assert(retried.ok && retried.value.kind === 'committed');
    } finally { repository.close(); store.clean(); }
  });
  test(`independent replay concurrent duplicates commit once: ${name}`, async () => {
    const store = disk(), repository = new SqliteProcurement(store.path, 'g1');
    try {
      const command = build(repository).requests.create;
      const results = await Promise.all(Array.from({ length: 4 }, () => command.run({ requestId: 'same', input })));
      assert(results.every(result => result.ok));
      assert.equal(results.filter(result => result.ok && result.value.kind === 'committed').length, 1);
      assert.equal(repository.list('request', actor).length, 1);
    } finally { repository.close(); store.clean(); }
  });
}
if (false) {
  const commands = builders.helper(null as unknown as ReplayRepository);
  // @ts-expect-error request identity remains required in the independent driver
  commands.requests.create.run({ input });
  // @ts-expect-error operation-specific input survives independent wrapping
  commands.inventory.move.run({ requestId: 'move', input: { id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 1 } });
}
