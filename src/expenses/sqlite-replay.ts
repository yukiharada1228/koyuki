import { createHash } from 'node:crypto';
import { ok, err, type Result, type Receipt, type Execution } from '../framework/index.js';
import { SqliteExpenses } from './sqlite.js';
import { restoreExpense, type Actor, type Input, type RejectInput, type Change, type ExpenseState } from './domain.js';
import type { SaveError, ExpenseRepository } from './repository.js';
export type ExpenseOperation = 'submit' | 'approve' | 'reject';
export interface ExpenseRequest {
  readonly operation: ExpenseOperation; readonly actor: Actor;
  readonly requestId: string; readonly input: Input | RejectInput;
}
export type ReplayStorageError = SaveError | { kind: 'InvalidRequest' } | { kind: 'IdempotencyConflict' };
export interface ExpenseReplayRepository extends ExpenseRepository {
  receipt(request: ExpenseRequest): Result<Receipt<ExpenseState>, ReplayStorageError> | Promise<Result<Receipt<ExpenseState>, ReplayStorageError>>;
  saveRequest(request: ExpenseRequest, change: Change): Promise<Result<Execution<ExpenseState>, ReplayStorageError>>;
}
function validRequest(r: ExpenseRequest): boolean {
  return !!r && typeof r === 'object' && !!r.input && typeof r.input === 'object' &&
    ['submit', 'approve', 'reject'].includes(r.operation) && typeof r.requestId === 'string' && r.requestId.length > 0 && r.requestId.length <= 200 && r.requestId.trim() === r.requestId &&
    typeof r.input.id === 'string' && r.input.id.length > 0 && Number.isSafeInteger(r.input.expectedVersion) && r.input.expectedVersion > 0 &&
    (r.operation !== 'reject' || ('reason' in r.input && typeof r.input.reason === 'string'));
}
// Scope successful replay to trusted host identity, not a role supplied by the event.
function fingerprint(r: ExpenseRequest): string {
  return createHash('sha256').update(JSON.stringify(['expenses.v1', r.operation, r.actor.id, r.actor.role, r.actor.active,
    r.input.id, r.input.expectedVersion, r.operation === 'reject' && 'reason' in r.input ? r.input.reason : null])).digest('hex');
}
function matchesOperation(operation: ExpenseOperation, state: ExpenseState): boolean {
  if (operation === 'reject') return state.kind === 'rejected';
  if (operation === 'submit') return state.kind === 'manager' || (state.kind === 'approved' && state.approval.kind === 'automatic');
  return state.kind === 'finance' || (state.kind === 'approved' && state.approval.kind !== 'automatic');
}
/** Optional adapter extension. Original expense domain and non-replay API remain unchanged. */
export class ReplaySqliteExpenses extends SqliteExpenses implements ExpenseReplayRepository {
  constructor(path: string) {
    super(path);
    try { this.db.exec('CREATE TABLE IF NOT EXISTS expense_receipts(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL)'); }
    catch (error) { this.close(); throw error; }
  }
  receipt(request: ExpenseRequest): Result<Receipt<ExpenseState>, ReplayStorageError> {
    if (!validRequest(request)) return err({ kind: 'InvalidRequest' });
    try {
      const row = this.db.prepare('SELECT * FROM expense_receipts WHERE request_id=?').get(request.requestId);
      if (!row) return ok({ kind: 'missing' });
      if (row.fingerprint !== fingerprint(request)) return err({ kind: 'IdempotencyConflict' });
      let raw: unknown; try { raw = JSON.parse(String(row.result_json)); } catch { return err({ kind: 'CorruptExpense' }); }
      const restored = restoreExpense(raw); if (!restored.ok) return restored;
      if (restored.value.id !== request.input.id || restored.value.version !== request.input.expectedVersion + 1 ||
          !matchesOperation(request.operation, restored.value)) return err({ kind: 'CorruptExpense' });
      return ok({ kind: 'found', value: restored.value });
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  async saveRequest(request: ExpenseRequest, change: Change): Promise<Result<Execution<ExpenseState>, ReplayStorageError>> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.commitRequest(request, change);
      this.db.exec(result.ok ? 'COMMIT' : 'ROLLBACK'); return result;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* BEGIN itself may fail. */ }
      return err({ kind: 'RepositoryUnavailable' });
    }
  }
  private commitRequest(request: ExpenseRequest, change: Change): Result<Execution<ExpenseState>, ReplayStorageError> {
    const cached = this.receipt(request); if (!cached.ok) return cached;
    if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
    if (change.next.id !== request.input.id || change.expectedVersion !== request.input.expectedVersion ||
        !matchesOperation(request.operation, change.next)) return err({ kind: 'InvalidRequest' });
    const saved = this.commit(change); if (!saved.ok) return saved;
    this.db.prepare('INSERT INTO expense_receipts VALUES(?,?,?)').run(request.requestId, fingerprint(request), JSON.stringify(saved.value));
    return ok({ kind: 'committed', value: saved.value });
  }
}
