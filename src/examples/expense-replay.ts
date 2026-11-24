import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { draftExpense, type Actor } from '../expenses/domain.js';
import { ReplaySqliteExpenses } from '../expenses/sqlite-replay.js';
import { expenseReplayCommands, expenseReplayApplication } from '../expenses/replay.js';
const dir = mkdtempSync(join(tmpdir(), 'koyuki-expense-demo-'));
const repository = new ReplaySqliteExpenses(join(dir, 'db.sqlite'));
try {
  const draft = draftExpense({ id: 'expense-1', owner: 'employee', amount: 5000, receipt: true }); assert(draft.ok);
  assert(repository.insertDraft(draft.value).ok);
  const employee: Actor = { id: 'employee', role: 'employee', active: true };
  const manager: Actor = { id: 'manager', role: 'manager', active: true };
  const request = { requestId: 'submit-1', input: { id: 'expense-1', expectedVersion: 1 } };
  const first = await expenseReplayCommands(repository, employee).submit.run(request); assert(first.ok);
  console.log('申請:', JSON.stringify(first));
  const approved = await expenseReplayCommands(repository, manager).approve.run({ requestId: 'approve-1', input: { id: 'expense-1', expectedVersion: 2 } }); assert(approved.ok);
  console.log('承認:', JSON.stringify(approved));
  const replay = await expenseReplayCommands(repository, employee).submit.run(request); assert(replay.ok && replay.value.kind === 'replayed');
  console.log('過去の申請の再送:', JSON.stringify(replay));
  const initial = repository.list(); assert(initial.ok);
  const session = await expenseReplayApplication(repository, employee, initial.value).start();
  await session.dispatch({ type: 'submit', input: request });
  assert.equal(session.snapshot().view.expenses[0]?.kind, 'approved');
  console.log('再送後のView（承認済みを維持）:', JSON.stringify(session.snapshot().view));
} finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
