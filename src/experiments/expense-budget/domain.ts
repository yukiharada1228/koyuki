import { ok, err, workflow, withInput, type Result } from '../../framework/index.js';
import { validateSubmission, submit, validateApproval, approve, validateRejection, returnForCorrection, validateEdit, edit, type Actor, type ExpenseState, type Input, type RejectInput, type EditInput, type Change, type RuleError } from '../../expenses/domain.js';
export type Action = 'submit' | 'approve' | 'return' | 'edit';
export type Request<A extends Action = Action> = (A extends 'return' ? RejectInput : A extends 'edit' ? EditInput : Input) & { readonly requestId: string };
export interface Budget { readonly id: string; readonly available: number; readonly version: number }
export interface Loaded<A extends Action = Action> { readonly current: ExpenseState; readonly actor: Actor; readonly input: Request<A>; readonly budget: Budget }
export interface BudgetChange { readonly expense: Change; readonly budget: Budget; readonly delta: number }
type SubmissionError = Extract<ReturnType<typeof submit>, { ok: false }>['error'];
export type DomainError = RuleError | SubmissionError | { kind: 'BudgetExceeded' } | { kind: 'InvalidBudget' };
function reserved(state: ExpenseState): number { return state.kind === 'manager' || state.kind === 'finance' || state.kind === 'approved' ? state.amount : 0; }
/** Pure budget calculation. Storage still must compare both versions atomically. */
export function budgetChange(context: { current: ExpenseState; budget: Budget }, expense: Change): Result<BudgetChange, { kind: 'BudgetExceeded' } | { kind: 'InvalidBudget' }> {
  const budget = context.budget;
  if (!budget.id.trim() || !Number.isSafeInteger(budget.available) || budget.available < 0 || !Number.isSafeInteger(budget.version) || budget.version < 1) return err({ kind: 'InvalidBudget' });
  const delta = reserved(context.current) - reserved(expense.next);
  if (budget.available + delta < 0) return err({ kind: 'BudgetExceeded' });
  if (!Number.isSafeInteger(budget.available + delta)) return err({ kind: 'InvalidBudget' });
  return ok(Object.freeze({ expense, budget: Object.freeze({ ...budget }), delta }));
}
function budgeted<I extends { current: ExpenseState; budget: Budget }, P, E, F>(validateName: string, validate: (input: I) => Result<P, E>, evolveName: string, evolve: (proof: P) => Result<Change, F>) {
  return workflow(validateName, withInput(validate))
    .then(evolveName, ({ input, value }) => {
      const result = evolve(value);
      return result.ok ? ok({ context: input, change: result.value }) : result;
    })
    .then('allocate-budget', ({ context, change }) => budgetChange(context, change));
}
export const budgetedSubmission = budgeted('validate-submission', (input: Loaded<'submit'>) => validateSubmission(input), 'submit', submit);
export const budgetedApproval = budgeted('authorize-approval', (input: Loaded<'approve'>) => validateApproval(input), 'approve', approve);
export const budgetedReturn = budgeted('authorize-return', (input: Loaded<'return'>) => validateRejection(input), 'return', returnForCorrection);
export const budgetedEdit = budgeted('validate-edit', (input: Loaded<'edit'>) => validateEdit(input), 'edit', edit);
export function decide<A extends Action>(action: A, context: Loaded<A>): Result<BudgetChange, DomainError> {
  // TypeScript does not narrow a generic A when action is narrowed. These casts
  // are confined to dispatch; public declarations and parseRequest check the pair.
  switch (action) {
    case 'submit': return budgetedSubmission.run(context as Loaded<'submit'>);
    case 'approve': return budgetedApproval.run(context as Loaded<'approve'>);
    case 'return': return budgetedReturn.run(context as Loaded<'return'>);
    case 'edit': return budgetedEdit.run(context as Loaded<'edit'>);
    default: throw new Error('UnknownExpenseAction');
  }
}
export type InvalidRequest = { kind: 'InvalidRequest' };
export function parseRequest<A extends Action>(action: A, value: unknown): Result<Request<A>, InvalidRequest>;
export function parseRequest(action: Action, value: unknown): Result<Request, InvalidRequest> {
  if (!value || typeof value !== 'object') return err({ kind: 'InvalidRequest' });
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim() || typeof v.requestId !== 'string' || !v.requestId.trim() || !Number.isSafeInteger(v.expectedVersion) || (v.expectedVersion as number) < 1) return err({ kind: 'InvalidRequest' });
  const base = { id: v.id, requestId: v.requestId, expectedVersion: v.expectedVersion as number };
  if (action === 'return') return typeof v.reason === 'string' ? ok({ ...base, reason: v.reason }) : err({ kind: 'InvalidRequest' });
  if (action === 'edit') return Number.isSafeInteger(v.amount) && (v.amount as number) > 0 && typeof v.receipt === 'boolean' ? ok({ ...base, amount: v.amount as number, receipt: v.receipt }) : err({ kind: 'InvalidRequest' });
  return ok(base);
}
