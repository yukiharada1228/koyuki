import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Result, type Receipt, type Execution } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import { restoreExpense, validExpenseChange, type Actor, type ExpenseState } from '../../expenses/domain.js';
import { budgetChange, parseRequest, type Action, type Request, type Loaded, type BudgetChange, type Budget } from './domain.js';
import { fingerprint, receiptMatches, type Repository, type Identity, type StorageError, type Snapshot } from './repository.js';
function validBudget(value: unknown): value is Budget {
  if (!value || typeof value !== 'object') return false;
  const v = value as Budget;
  return typeof v.id === 'string' && !!v.id.trim() && Number.isSafeInteger(v.available) && v.available >= 0 && Number.isSafeInteger(v.version) && v.version > 0;
}
/** Host-only SQLite adapter. Framework runtime has no node:sqlite dependency. */
export class BudgetSqliteExpenses implements Repository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(request_id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  /** Test/example initialization only; one department per database in this representative example. */
  seed(expenses: readonly ExpenseState[], budget: Budget) {
    if (!validBudget(budget) || expenses.some(expense => !restoreExpense(expense).ok)) throw new Error('InvalidSeed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO budgets VALUES(?,?)').run(budget.id, JSON.stringify(budget));
      for (const expense of expenses) this.db.prepare('INSERT INTO expenses VALUES(?,?)').run(expense.id, JSON.stringify(expense));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private readExpense(id: string): Result<ExpenseState, StorageError> {
    const row = this.db.prepare('SELECT data FROM expenses WHERE id=?').get(id);
    if (!row) return err({ kind: 'Missing' });
    const restored = restoreExpense(JSON.parse(String(row.data)));
    return restored.ok ? restored : err({ kind: 'StorageFailed' });
  }
  private readBudget(): Budget {
    const rows = this.db.prepare('SELECT data FROM budgets').all();
    if (rows.length !== 1) throw new Error('ExpectedOneDepartment');
    const value: unknown = JSON.parse(String(rows[0]!.data));
    if (!validBudget(value)) throw new Error('CorruptBudget');
    return value;
  }
  async load<A extends Action>(input: Request<A>, actor: Actor): Promise<Result<Loaded<A>, StorageError>> {
    try {
      const current = this.readExpense(input.id);
      if (!current.ok) return current;
      if (current.value.version !== input.expectedVersion) return err({ kind: 'Conflict' });
      return ok({ current: current.value, budget: this.readBudget(), actor: structuredClone(actor), input: structuredClone(input) });
    } catch { return err({ kind: 'StorageFailed' }); }
  }
  private readReceipt(request: Request, identity: Identity): Result<Receipt<ExpenseState>, StorageError> {
    const parsed = parseRequest(identity.action, request);
    if (!parsed.ok) return parsed;
    const row = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(parsed.value.requestId);
    if (!row) return ok({ kind: 'missing' });
    if (row.fingerprint !== fingerprint(parsed.value, identity)) return err({ kind: 'IdempotencyConflict' });
    let value: unknown;
    try { value = JSON.parse(String(row.data)); } catch { return err({ kind: 'CorruptReceipt' }); }
    const restored = restoreExpense(value);
    if (!restored.ok || !receiptMatches(restored.value, request, identity)) return err({ kind: 'CorruptReceipt' });
    return ok({ kind: 'found', value: restored.value });
  }
  async receipt<A extends Action>(request: Request<A>, identity: Identity) {
    try { return this.readReceipt(request, identity); } catch { return err({ kind: 'StorageFailed' as const }); }
  }
  async save<A extends Action>(change: BudgetChange, request: Request<A>, identity: Identity, events: readonly EventEnvelope[]): Promise<Result<Execution<ExpenseState>, StorageError>> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const abort = (failure: Result<never, StorageError>) => { this.db.exec('ROLLBACK'); return failure; };
      const cached = this.readReceipt(request, identity);
      if (!cached.ok) return abort(cached);
      if (cached.value.kind === 'found') { this.db.exec('COMMIT'); return ok({ kind: 'replayed', value: cached.value.value }); }
      const current = this.readExpense(request.id), budget = this.readBudget();
      if (!current.ok) return abort(current);
      const next = restoreExpense(change.expense.next);
      if (!next.ok || request.expectedVersion !== change.expense.expectedVersion || !validExpenseChange(current.value, next.value, request.expectedVersion) || !receiptMatches(next.value, request, identity)) return abort(err({ kind: 'Conflict' }));
      const computed = budgetChange({ current: current.value, budget }, change.expense);
      if (!computed.ok || computed.value.delta !== change.delta || change.budget.id !== budget.id || change.budget.version !== budget.version || change.budget.available !== budget.available) return abort(err({ kind: 'Conflict' }));
      // BEGIN IMMEDIATE keeps these compare/update pairs atomic across connections.
      this.db.prepare('UPDATE expenses SET data=? WHERE id=?').run(JSON.stringify(next.value), next.value.id);
      if (change.delta !== 0) this.db.prepare('UPDATE budgets SET data=? WHERE id=?').run(JSON.stringify({ ...budget, available: budget.available + change.delta, version: budget.version + 1 }), budget.id);
      for (const event of events) this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(event.id, JSON.stringify(event));
      this.db.prepare('INSERT INTO audit VALUES(?,?)').run(request.requestId, JSON.stringify({ action: identity.action, actor: identity.actor.id, before: current.value, after: next.value, budgetDelta: change.delta }));
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(request.requestId, fingerprint(request, identity), JSON.stringify(next.value));
      this.db.exec('COMMIT');
      return ok({ kind: 'committed', value: next.value });
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      return err({ kind: 'StorageFailed' });
    }
  }
  snapshot(): Snapshot {
    return { expenses: this.db.prepare('SELECT data FROM expenses ORDER BY id').all().map(row => JSON.parse(String(row.data)) as ExpenseState), budget: this.readBudget(),
      events: this.db.prepare('SELECT data FROM outbox ORDER BY rowid').all().map(row => JSON.parse(String(row.data)) as EventEnvelope), receipts: Number(this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n) };
  }
  auditCount() { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM audit').get()!.n); }
}
