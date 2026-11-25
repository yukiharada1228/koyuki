import { createHash } from 'node:crypto';
import { ok, err, type Result, type Receipt, type Execution } from '../framework/index.js';
import { SqliteExpenses } from './sqlite.js';
import { restoreExpense, type Actor, type Input, type RejectInput, type EditInput, type Change, type ExpenseState } from './domain.js';
import type { SaveError, ExpenseRepository } from './repository.js';
export type ExpenseOperation = 'submit' | 'approve' | 'reject' | 'return' | 'edit';
export interface ExpenseRequest {
  readonly operation: ExpenseOperation; readonly actor: Actor;
  readonly requestId: string; readonly input: Input | RejectInput | EditInput;
}
export type ReplayStorageError = SaveError | { kind: 'InvalidRequest' } | { kind: 'IdempotencyConflict' };
export interface ExpenseReplayRepository extends ExpenseRepository {
  receipt(request: ExpenseRequest): Result<Receipt<ExpenseState>, ReplayStorageError> | Promise<Result<Receipt<ExpenseState>, ReplayStorageError>>;
  saveRequest(request: ExpenseRequest, change: Change): Promise<Result<Execution<ExpenseState>, ReplayStorageError>>;
}
function validRequest(r: ExpenseRequest): boolean {
  return !!r && typeof r === 'object' && !!r.input && typeof r.input === 'object' &&
    ['submit', 'approve', 'reject', 'return', 'edit'].includes(r.operation) && typeof r.requestId === 'string' && r.requestId.length > 0 && r.requestId.length <= 200 && r.requestId.trim() === r.requestId &&
    typeof r.input.id === 'string' && r.input.id.length > 0 && Number.isSafeInteger(r.input.expectedVersion) && r.input.expectedVersion > 0 &&
    (!['reject', 'return'].includes(r.operation) || ('reason' in r.input && typeof r.input.reason === 'string')) &&
    (r.operation !== 'edit' || ('amount' in r.input && Number.isSafeInteger(r.input.amount) && 'receipt' in r.input && typeof r.input.receipt === 'boolean'));
}
// Scope successful replay to trusted host identity, not a role supplied by the event.
function fingerprint(r: ExpenseRequest): string {
  const fields: unknown[] = ['expenses.v1', r.operation, r.actor.id, r.actor.role, r.actor.active,
    r.input.id, r.input.expectedVersion, ['reject', 'return'].includes(r.operation) && 'reason' in r.input ? r.input.reason : null];
  // Preserve existing receipt fingerprints for the original three operations.
  if (r.operation === 'edit' && 'amount' in r.input && 'receipt' in r.input) fields.push(r.input.amount, r.input.receipt);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function matchesOperation(operation: ExpenseOperation, state: ExpenseState): boolean {
  if (operation === 'return') return state.kind === 'returned';
  if (operation === 'edit') return state.kind === 'draft';
  if (operation === 'reject') return state.kind === 'rejected';
  if (operation === 'submit') return state.kind === 'manager' || (state.kind === 'approved' && state.approval.kind === 'automatic');
  return state.kind === 'finance' || (state.kind === 'approved' && state.approval.kind !== 'automatic');
}
/** Optional receipt boundary sharing the ordinary expense storage transaction. */
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
      return this.transaction.run(() => this.commitRequest(request, change));
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }

  private commitRequest(request: ExpenseRequest, change: Change): Result<Execution<ExpenseState>, ReplayStorageError> {
    const cached = this.receipt(request); if (!cached.ok) return cached;
    if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
    if (change.next.id !== request.input.id || change.expectedVersion !== request.input.expectedVersion ||
        !matchesOperation(request.operation, change.next)) return err({ kind: 'InvalidRequest' });
    if (request.operation === 'edit' && (!('amount' in request.input) || !('receipt' in request.input) ||
        change.next.amount !== request.input.amount || change.next.receipt !== request.input.receipt)) return err({ kind: 'InvalidRequest' });
    if ((request.operation === 'return' || request.operation === 'reject') &&
        (!('reason' in request.input) || !('reason' in change.next) || change.next.reason !== request.input.reason.trim())) return err({ kind: 'InvalidRequest' });
    const saved = this.commit(change); if (!saved.ok) return saved;
    this.db.prepare('INSERT INTO expense_receipts VALUES(?,?,?)').run(request.requestId, fingerprint(request), JSON.stringify(saved.value));
    return ok({ kind: 'committed', value: saved.value });
  }
}
