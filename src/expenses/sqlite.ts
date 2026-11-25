import { SqliteAudit, type SqliteAuditOptions } from '../adapters/sqlite-audit.js';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { createSyncTransaction, ok, err, type Result } from '../framework/index.js';
import { restoreExpense, validExpenseChange, type Actor, type Change, type Draft, type ExpenseState, type Input, type Loaded, type RejectInput } from './domain.js';
import type { ExpenseRepository, LoadError, SaveError, StorageError } from './repository.js';
type Row = Record<string, SQLOutputValue>;
export class SqliteExpenses implements ExpenseRepository {
  protected readonly db: DatabaseSync;
  protected readonly transaction = createSyncTransaction({
    begin: () => { this.db.exec('BEGIN IMMEDIATE'); },
    commit: () => { this.db.exec('COMMIT'); },
    rollback: () => { this.db.exec('ROLLBACK'); },
  });
  private readonly audit: SqliteAudit;
  constructor(path: string, options: { audit?: SqliteAuditOptions } = {}) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('UnsupportedExpenseSchema');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS expense_changes(expense_id TEXT NOT NULL REFERENCES expenses(id), version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(expense_id,version));
        PRAGMA user_version=1; COMMIT;`);
      this.audit = new SqliteAudit(this.db, options.audit);
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
    if (valid.value.kind !== 'draft' || valid.value.version !== 1 || valid.value.draftVersion !== undefined) return err({ kind: 'CorruptExpense' });
    const state = valid.value;
    try {
      return this.transaction.run(() => {
        const result = this.db.prepare('INSERT OR IGNORE INTO expenses(id,version,state_json) VALUES(?,?,?)').run(draft.id, 1, JSON.stringify(state));
        if (result.changes !== 1) return err({ kind: 'SaveConflict' as const });
        this.audit.append('expense.create.v1', { targetType: 'expense', targetId: draft.id, beforeVersion: null, afterVersion: 1 });
        return ok(state);
      });
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  private loadInput<I extends Input>(input: I, actor: Actor): Result<Loaded<I>, LoadError> {
    const current = this.read(input.id); if (!current.ok) return current;
    if (current.value.version !== input.expectedVersion) return err({ kind: 'SaveConflict' });
    return ok({ current: current.value, input: structuredClone(input), actor: structuredClone(actor) });
  }
  async load<I extends Input>(input: I, actor: Actor) { return this.loadInput(input, actor); }
  async loadReject(input: RejectInput, actor: Actor) { return this.loadInput(input, actor); }
  async save(change: Change): Promise<Result<ExpenseState, SaveError>> {
    try {
      return this.transaction.run(() => this.commit(change));
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }

  protected commit(change: Change): Result<ExpenseState, SaveError> {
    const current = this.read(change.next.id); if (!current.ok) return current.error.kind === 'NotFound' ? err({ kind: 'SaveConflict' }) : err(current.error);
    const next = restoreExpense(change.next); if (!next.ok) return next;
    const before = current.value, after = next.value;
    if (!validExpenseChange(before, after, change.expectedVersion)) return err({ kind: 'SaveConflict' });
    const json = JSON.stringify(after);
    const update = this.db.prepare('UPDATE expenses SET version=?,state_json=? WHERE id=? AND version=?').run(after.version, json, after.id, change.expectedVersion);
    if (update.changes !== 1) return err({ kind: 'SaveConflict' });
    this.db.prepare('INSERT INTO expense_changes(expense_id,version,state_json) VALUES(?,?,?)').run(after.id, after.version, json);
    const operation = before.kind === 'draft' ? 'submit' : after.kind === 'returned' ? 'return' : after.kind === 'draft' ? 'edit' : after.kind === 'rejected' ? 'reject' : 'approve';
    this.audit.append(`expense.${operation}.v1`, { targetType: 'expense', targetId: after.id, beforeVersion: before.version, afterVersion: after.version });
    return ok(after);
  }
}
