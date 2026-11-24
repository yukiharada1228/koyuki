import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { ok, err, type Result } from '../framework/index.js';
import { restoreExpense, type Actor, type Change, type Draft, type ExpenseState, type Input, type Loaded, type RejectInput } from './domain.js';
import type { ExpenseRepository, LoadError, SaveError, StorageError } from './repository.js';
type Row = Record<string, SQLOutputValue>;
export class SqliteExpenses implements ExpenseRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('UnsupportedExpenseSchema');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS expense_changes(expense_id TEXT NOT NULL REFERENCES expenses(id), version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(expense_id,version));
        PRAGMA user_version=1; COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private hydrate(row: Row): Result<ExpenseState, StorageError> {
    let raw: unknown; try { raw = JSON.parse(String(row.state_json)); } catch { return err({ kind: 'CorruptExpense' }); }
    const restored = restoreExpense(raw);
    if (!restored.ok) return restored;
    return restored.value.id === row.id && restored.value.version === row.version ? restored : err({ kind: 'CorruptExpense' });
  }
  read(id: string): Result<ExpenseState, LoadError> {
    try { const row = this.db.prepare('SELECT * FROM expenses WHERE id=?').get(id); return row ? this.hydrate(row) : err({ kind: 'NotFound' }); }
    catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  list(): Result<readonly ExpenseState[], StorageError> {
    try {
      const values: ExpenseState[] = [];
      for (const row of this.db.prepare('SELECT * FROM expenses ORDER BY id').all()) { const result = this.hydrate(row); if (!result.ok) return result; values.push(result.value); }
      return ok(values);
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  insertDraft(draft: Draft): Result<Draft, SaveError> {
    const valid = restoreExpense(draft); if (!valid.ok) return valid;
    if (valid.value.kind !== 'draft') return err({ kind: 'CorruptExpense' });
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO expenses(id,version,state_json) VALUES(?,?,?)').run(draft.id, 1, JSON.stringify(valid.value));
      return result.changes === 1 ? ok(valid.value) : err({ kind: 'SaveConflict' });
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  private loadInput<I extends Input>(input: I, actor: Actor): Result<Loaded<I>, LoadError> {
    const current = this.read(input.id); if (!current.ok) return current;
    if (current.value.version !== input.expectedVersion) return err({ kind: 'SaveConflict' });
    return ok({ current: current.value, input: structuredClone(input), actor: structuredClone(actor) });
  }
  async load(input: Input, actor: Actor) { return this.loadInput(input, actor); }
  async loadReject(input: RejectInput, actor: Actor) { return this.loadInput(input, actor); }
  async save(change: Change): Promise<Result<ExpenseState, SaveError>> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.commit(change);
      if (result.ok) this.db.exec('COMMIT'); else this.db.exec('ROLLBACK');
      return result;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* BEGIN may have failed. */ }
      return err({ kind: 'RepositoryUnavailable' });
    }
  }
  private commit(change: Change): Result<ExpenseState, SaveError> {
    const current = this.read(change.next.id); if (!current.ok) return current.error.kind === 'NotFound' ? err({ kind: 'SaveConflict' }) : err(current.error);
    const next = restoreExpense(change.next); if (!next.ok) return next;
    const before = current.value, after = next.value;
    if (before.version !== change.expectedVersion || after.version !== before.version + 1 || before.owner !== after.owner || before.amount !== after.amount || before.receipt !== after.receipt) return err({ kind: 'SaveConflict' });
    const allowed = before.kind === 'draft' ? after.kind === 'manager' || (after.kind === 'approved' && after.approval.kind === 'automatic')
      : before.kind === 'manager' ? after.kind === 'finance' || after.kind === 'rejected' || (after.kind === 'approved' && after.approval.kind === 'manager')
      : before.kind === 'finance' ? after.kind === 'rejected' || (after.kind === 'approved' && after.approval.kind === 'finance' && after.approval.manager === before.manager)
      : false;
    if (!allowed) return err({ kind: 'SaveConflict' });
    if (before.kind === 'finance' && after.kind === 'rejected' && (after as ExpenseState & { manager?: string }).manager !== before.manager) return err({ kind: 'SaveConflict' });
    const json = JSON.stringify(after);
    const update = this.db.prepare('UPDATE expenses SET version=?,state_json=? WHERE id=? AND version=?').run(after.version, json, after.id, change.expectedVersion);
    if (update.changes !== 1) return err({ kind: 'SaveConflict' });
    this.db.prepare('INSERT INTO expense_changes(expense_id,version,state_json) VALUES(?,?,?)').run(after.id, after.version, json);
    return ok(after);
  }
}
