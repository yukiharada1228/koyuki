import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import { validExpenseChange, restoreExpense, type Actor, type ExpenseState } from '../../expenses/domain.js';
import { budgetChange, parseRequest, type Action, type Request, type Loaded, type BudgetChange, type Budget } from './domain.js';
import { fingerprint, receiptMatches, type Identity, type Repository, type StorageError, type Snapshot } from './repository.js';
/** Single-process atomic adapter. No database, no durability after restart. */
export class MemoryBudgetExpenses implements Repository {
  private expenses = new Map<string, ExpenseState>();
  private receipts = new Map<string, { fingerprint: string; value: ExpenseState }>();
  private events: EventEnvelope[] = [];
  private audits = 0;
  private budget: Budget;
  constructor(expenses: readonly ExpenseState[], budget: Budget) {
    if (!budget.id.trim() || !Number.isSafeInteger(budget.available) || budget.available < 0 || !Number.isSafeInteger(budget.version) || budget.version < 1 || expenses.some(value => !restoreExpense(value).ok)) throw new Error('InvalidSeed');
    for (const expense of expenses) this.expenses.set(expense.id, structuredClone(expense));
    this.budget = structuredClone(budget);
  }
  async load<A extends Action>(input: Request<A>, actor: Actor): Promise<Result<Loaded<A>, StorageError>> {
    const current = this.expenses.get(input.id);
    if (!current) return err({ kind: 'Missing' });
    if (current.version !== input.expectedVersion) return err({ kind: 'Conflict' });
    return ok(structuredClone({ current, actor, input, budget: this.budget }));
  }
  private lookup(input: Request, identity: Identity): Result<Receipt<ExpenseState>, StorageError> {
    const request = parseRequest(identity.action, input);
    if (!request.ok) return request;
    const record = this.receipts.get(request.value.requestId);
    if (!record) return ok({ kind: 'missing' });
    return record.fingerprint === fingerprint(request.value, identity) ? ok({ kind: 'found', value: structuredClone(record.value) }) : err({ kind: 'IdempotencyConflict' });
  }
  async receipt<A extends Action>(input: Request<A>, identity: Identity) { return this.lookup(input, identity); }
  async save<A extends Action>(change: BudgetChange, request: Request<A>, identity: Identity, events: readonly EventEnvelope[]): Promise<Result<Execution<ExpenseState>, StorageError>> {
    const cached = this.lookup(request, identity);
    if (!cached.ok) return cached;
    if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
    const current = this.expenses.get(request.id), budget = this.budget;
    const restored = restoreExpense(change.expense.next);
    if (!current || !restored.ok || request.expectedVersion !== change.expense.expectedVersion || !validExpenseChange(current, restored.value, request.expectedVersion) || !receiptMatches(restored.value, request, identity)) return err({ kind: 'Conflict' });
    const checked = budgetChange({ current, budget }, change.expense);
    if (!checked.ok || checked.value.delta !== change.delta || change.budget.id !== budget.id || change.budget.version !== budget.version || change.budget.available !== budget.available) return err({ kind: 'Conflict' });
    const ids = new Set(this.events.map(event => event.id));
    for (const event of events) {
      if (ids.has(event.id)) return err({ kind: 'StorageFailed' });
      ids.add(event.id);
    }
    // Own every value before mutating; no await occurs between compare and replacement.
    const next = structuredClone(restored.value), ownedEvents = structuredClone(events);
    const receipt = { fingerprint: fingerprint(request, identity), value: structuredClone(next) };
    this.expenses.set(next.id, next);
    if (change.delta !== 0) this.budget = { ...budget, available: budget.available + change.delta, version: budget.version + 1 };
    this.events.push(...ownedEvents); this.receipts.set(request.requestId, receipt); this.audits++;
    return ok({ kind: 'committed', value: structuredClone(next) });
  }
  snapshot(): Snapshot { return structuredClone({ expenses: [...this.expenses.values()].sort((a,b) => a.id.localeCompare(b.id)), budget: this.budget, events: this.events, receipts: this.receipts.size }); }
  auditCount() { return this.audits; }
  close() {}
}
