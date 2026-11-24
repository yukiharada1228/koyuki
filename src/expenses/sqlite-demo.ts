import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftExpense, type Actor } from './domain.js';
import { SqliteExpenses } from './sqlite.js';
import { expenseApplication } from './application.js';
const directory = mkdtempSync(join(tmpdir(), 'expenses-demo-')), path = join(directory, 'expenses.sqlite');
try {
  const seed = new SqliteExpenses(path);
  try {
    const draft = draftExpense({ id: 'expense-1', owner: 'employee-1', amount: 200000, receipt: true });
    if (!draft.ok || !seed.insertDraft(draft.value).ok) throw new Error('SeedFailed');
  } finally { seed.close(); }
  for (const [actor, type, version] of [
    [{ id: 'employee-1', role: 'employee', active: true }, 'submit', 1],
    [{ id: 'manager-1', role: 'manager', active: true }, 'approve', 2],
    [{ id: 'finance-1', role: 'finance', active: true }, 'approve', 3],
  ] satisfies readonly [Actor, 'submit' | 'approve', number][]) {
    // Reopen storage and rebuild the application from saved business state for every actor.
    const repository = new SqliteExpenses(path);
    try {
      const rows = repository.list(); if (!rows.ok) throw new Error(rows.error.kind);
      const session = await expenseApplication(repository, actor, rows.value).start();
      await session.dispatch({ type, input: { id: 'expense-1', expectedVersion: version } });
      console.log(JSON.stringify({ actor: actor.role, state: session.snapshot().state }));
    } finally { repository.close(); }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
