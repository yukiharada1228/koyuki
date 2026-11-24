// Copied beside the unchanged alpha.2 leave sample by test:leave:development.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from 'koyuki';
import { SqliteLeave } from './repository.js';
import { leaveCommands } from './application.js';
const employee = { id: 'owner', role: 'employee', active: true } as const;
const call = { requestId: 'submit', input: { employee: 'owner', leaveId: 'leave', expectedVersion: 1, days: 3 } };
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-trace-'));
  const repo = new SqliteLeave(join(dir, 'db.sqlite')); assert(repo.seed('owner', 5).ok);
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); }); return repo;
}
test('leave detailed commit records real requirements while replay skips domain execution', async t => {
  const repo = fixture(t), command = leaveCommands(repo, employee);
  const committed = await command.submit.runDetailed(call); assert(committed.result.ok);
  assert.deepEqual(committed.attempt?.trace?.map(x => x.step), ['leave.submit.v1:load', 'authorize-submit', 'require-days', 'submit', 'leave.submit.v1']);
  const replay = await command.submit.runDetailed(call); assert(replay.result.ok);
  assert.equal(replay.result.value.kind, 'replayed'); assert.equal(replay.attempt, null);
  assert.equal(replay.trace.length, 2);
});
test('leave insufficient capacity shows no evolve or save; unknown commit keeps both outcomes', async t => {
  const repo = fixture(t), command = leaveCommands(repo, employee);
  const denied = await command.submit.runDetailed({ ...call, input: { ...call.input, days: 6 } });
  assert.deepEqual(denied.result, err({ kind: 'InsufficientDays' }));
  assert.deepEqual(denied.attempt?.trace?.map(x => x.step), ['leave.submit.v1:load', 'authorize-submit', 'require-days']);
  const save = repo.save.bind(repo);
  repo.save = async (request, change) => {
    const saved = await save(request, change); return saved.ok ? err({ kind: 'StorageUnavailable' as const }) : saved;
  };
  const resolved = await command.submit.runDetailed(call); assert(resolved.result.ok);
  assert.equal(resolved.result.value.kind, 'replayed');
  assert.deepEqual(resolved.attempt?.result, err({ kind: 'StorageUnavailable' }));
  assert.deepEqual(resolved.trace.at(-1), { kind: 'lookup', phase: 'after-error', status: 'found' });
});
