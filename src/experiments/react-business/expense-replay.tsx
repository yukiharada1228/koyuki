/** @jsx h */
import { ok, err, type Result, type Receipt, type Execution } from '../../framework/index.js';
import type { Actor, Input, Loaded, Change, ExpenseState } from '../../expenses/domain.js';
import type { LoadError, SaveError } from '../../expenses/repository.js';
import { h, createContext, useContext, defineOperation, Operation, defineResource, defineEvent, emit, defineQuery, Query, Fragment, type EventEnvelope } from './runtime.js';
import { approveExpense, ActorContext, useActor } from './expense.js';
export interface ApprovalRequest { readonly requestId: string; readonly input: Input }
export interface ApprovalIdentity extends ApprovalRequest { readonly operation: 'approve'; readonly actor: Actor }
export type ReplayStorageError = SaveError | { kind: 'InvalidRequest' } | { kind: 'IdempotencyConflict' };
/** Structural port: the existing atomic SQLite receipt adapter implements it unchanged. */
export interface ReplayExpenseRepository {
  read(id: string): Result<ExpenseState, LoadError> | Promise<Result<ExpenseState, LoadError>>;
  load(input: Input, actor: Actor): Promise<Result<Loaded, LoadError>>;
  receipt(request: ApprovalIdentity): Result<Receipt<ExpenseState>, ReplayStorageError> | Promise<Result<Receipt<ExpenseState>, ReplayStorageError>>;
  saveRequest(request: ApprovalIdentity, change: Change, events?: readonly EventEnvelope[]): Promise<Result<Execution<ExpenseState>, ReplayStorageError>>;
}
export const ReplayExpenseRepositoryContext = createContext<ReplayExpenseRepository>();
export const expenseChanged = defineEvent<{ id: string }>('expense.changed.v1', { external: true, decode: value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id ? ok({ id: value.id }) : err('InvalidExpenseEvent') });
const approvalContext = defineResource('expense-approval-context', () => {
  const expenses = useContext(ReplayExpenseRepositoryContext), actor = useActor();
  return (call: ApprovalRequest) => expenses.load(call.input, actor);
});
function useApprovalServices() { return { expenses: useContext(ReplayExpenseRepositoryContext), actor: useActor() }; }
export const replayedApproval = defineOperation('expense.approve.v1', {
  needs: approvalContext, execute: approveExpense,
  emits: [emit(expenseChanged, (change: Change) => ({ id: change.next.id }))],
  useSave: () => { const { expenses, actor } = useApprovalServices();
    return (change: Change, call: ApprovalRequest, events: readonly EventEnvelope[]) => expenses.saveRequest({ ...call, operation: 'approve', actor }, change, events);
  },
  useReplay: () => { const { expenses, actor } = useApprovalServices(); return {
    lookup: (call: ApprovalRequest) => expenses.receipt({ ...call, operation: 'approve', actor }),
    resolveAfter: (error: { kind: string }) => error.kind === 'SaveConflict' || error.kind === 'InvalidState' || error.kind === 'RepositoryUnavailable',
  }; },
});
const expenseRead = defineResource('expense-query', () => {
  const { expenses, actor } = useApprovalServices();
  return async (input: { id: string }): Promise<Result<ExpenseState, LoadError | { kind: 'Forbidden' }>> => {
    if (!actor.active) return err({ kind: 'Forbidden' });
    const result = await expenses.read(input.id);
    return result.ok && actor.role === 'employee' && result.value.owner !== actor.id ? err({ kind: 'Forbidden' }) : result;
  };
});
export const expenseQuery = defineQuery('expense.query.v1', { needs: expenseRead, select: (state: ExpenseState) => ok(state) });
export function ReplayApproveExpense() {
  return <Operation operation={replayedApproval} />;
}
export function ReplayExpenses({ repository, actor }: { repository: ReplayExpenseRepository; actor: Actor }) {
  return <ReplayExpenseRepositoryContext.Provider value={repository}>
    <ActorContext.Provider value={actor}><Fragment><ReplayApproveExpense /><Query query={expenseQuery} /></Fragment></ActorContext.Provider>
  </ReplayExpenseRepositoryContext.Provider>;
}
