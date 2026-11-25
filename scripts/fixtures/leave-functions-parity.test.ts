import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLeave } from './repository.js';
import { leaveCommands as functions } from './application.js';
import { leaveCommands as named } from './application-named.js';
import type { ReplayReport } from 'koyuki';
import type { Account, RuleError } from './domain.js';
import type { StorageError } from './repository.js';
function defaultLabels(report: ReplayReport<Account, RuleError | StorageError, StorageError>) {
  // Only role labels change when explicit names are omitted. Preserve all other report fields.
  const labels: Record<string, string> = {
    'authorize-submit': 'validate', 'authorize-approval': 'validate', 'authorize-withdrawal': 'validate',
    submit: 'evolve', approve: 'evolve', withdraw: 'evolve',
  };
  return { ...report, attempt: report.attempt === null ? null : {
    ...report.attempt, trace: report.attempt.trace?.map(entry => ({ ...entry, step: labels[entry.step] ?? entry.step })) ?? null,
  } };
}
test('ordinary domain declarations agree with named declarations across all three operations and replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-functions-'));
  const a = new SqliteLeave(join(dir, 'a.sqlite')), b = new SqliteLeave(join(dir, 'b.sqlite'));
  try {
    assert(a.seed('owner', 5).ok); assert(b.seed('owner', 5).ok);
    const actor = { id: 'owner', role: 'employee', active: true } as const, boss = { id: 'boss', role: 'manager', active: true } as const;
    const before = named(a, actor), after = functions(b, actor), oldManager = named(a, boss), manager = functions(b, boss);
    const first = { requestId: 'first', input: { employee: 'owner', leaveId: 'first', expectedVersion: 1, days: 3 } };
    assert.deepEqual(await after.submit.runDetailed(first), defaultLabels(await before.submit.runDetailed(first)));
    const over = { requestId: 'over', input: { ...first.input, leaveId: 'over', expectedVersion: 2, days: 3 } };
    assert.deepEqual(await after.submit.runDetailed(over), defaultLabels(await before.submit.runDetailed(over)));
    const approval = { requestId: 'approval', input: { ...first.input, expectedVersion: 2 } };
    assert.deepEqual(await manager.approve.runDetailed(approval), defaultLabels(await oldManager.approve.runDetailed(approval)));
    const terminal = { requestId: 'terminal', input: { ...first.input, expectedVersion: 3 } };
    assert.deepEqual(await after.withdraw.runDetailed(terminal), defaultLabels(await before.withdraw.runDetailed(terminal)));
    const second = { requestId: 'second', input: { ...first.input, leaveId: 'second', expectedVersion: 3, days: 2 } };
    assert.deepEqual(await after.submit.runDetailed(second), defaultLabels(await before.submit.runDetailed(second)));
    const withdrawal = { requestId: 'withdrawal', input: { ...second.input, expectedVersion: 4 } };
    assert.deepEqual(await after.withdraw.runDetailed(withdrawal), defaultLabels(await before.withdraw.runDetailed(withdrawal)));
    assert.deepEqual(await after.submit.runDetailed(first), defaultLabels(await before.submit.runDetailed(first)));
    assert.deepEqual(a.read('owner'), b.read('owner'));
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
