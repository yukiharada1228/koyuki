/** @jsx h */
import type { Result, Receipt, Execution } from '../../framework/index.js';
import type { Actor, Input, Loaded, Change, ExpenseState } from '../../expenses/domain.js';
import type { LoadError, SaveError } from '../../expenses/repository.js';
import { h, createContext, useContext, defineOperation, Operation } from './runtime.js';
import { approveExpense, ActorContext, useActor } from './expense.js';
export interface ApprovalRequest { readonly requestId: string; readonly input: Input }
export interface ApprovalIdentity extends ApprovalRequest { readonly operation: 'approve'; readonly actor: Actor }
export type ReplayStorageError = SaveError | { kind: 'InvalidRequest' } | { kind: 'IdempotencyConflict' };
/** Structural port: the existing atomic SQLite receipt adapter implements it unchanged. */
export interface ReplayExpenseRepository {
  load(input: Input, actor: Actor): Promise<Result<Loaded, LoadError>>;
  receipt(request: ApprovalIdentity): Result<Receipt<ExpenseState>, ReplayStorageError> | Promise<Result<Receipt<ExpenseState>, ReplayStorageError>>;
  saveRequest(request: ApprovalIdentity, change: Change): Promise<Result<Execution<ExpenseState>, ReplayStorageError>>;
}
export const ReplayExpenseRepositoryContext = createContext<ReplayExpenseRepository>();
export const replayedApproval = defineOperation('expense.approve.v1', () => {
  const expenses = useContext(ReplayExpenseRepositoryContext);
  const actor = Object.freeze({ ...useActor() });
  const request = (call: ApprovalRequest): ApprovalIdentity => ({ ...call, operation: 'approve', actor });
  return {
    load: (call: ApprovalRequest) => expenses.load(call.input, actor),
    execute: approveExpense,
    save: (change, call) => expenses.saveRequest(request(call), change),
    replay: {
      lookup: call => expenses.receipt(request(call)),
      resolveAfter: error => error.kind === 'SaveConflict' || error.kind === 'InvalidState' || error.kind === 'RepositoryUnavailable',
    },
  };
});
export const useReplayExpenseApproval = replayedApproval.use;
export function ReplayApproveExpense() {
  return <Operation operation={replayedApproval} />;
}
export function ReplayExpenses({ repository, actor }: { repository: ReplayExpenseRepository; actor: Actor }) {
  return <ReplayExpenseRepositoryContext.Provider value={repository}>
    <ActorContext.Provider value={actor}><ReplayApproveExpense /></ActorContext.Provider>
  </ReplayExpenseRepositoryContext.Provider>;
}
