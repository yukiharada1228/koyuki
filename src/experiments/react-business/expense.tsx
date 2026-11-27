/** @jsx h */
import { workflow, type Result } from '../../framework/index.js';
import { validateApproval, approve, type Actor, type Input, type Loaded, type Change } from '../../expenses/domain.js';
import { h, createContext, useContext, defineOperation, Operation, defineResource } from './runtime.js';

// Independently callable pure business calculation. No hooks or repository needed.
export const approveExpense = workflow('authorize-approval', validateApproval).then('approve', approve);
export interface ExpenseRepository {
  load(input: Input, actor: Actor): Promise<Result<Loaded, 'LoadFailed'>>;
  save(change: Change): Promise<Result<Change, 'SaveFailed'>>;
}
export const ExpenseRepositoryContext = createContext<ExpenseRepository>();
export const ActorContext = createContext<Actor>();
export function useActor() { return Object.freeze({ ...useContext(ActorContext) }); }
export const expenseContext = defineResource('expense-context', () => {
  const expenses = useContext(ExpenseRepositoryContext), actor = useActor();
  return (input: Input) => expenses.load(input, actor);
});
export const approval = defineOperation('expense.approve.v1', {
  needs: expenseContext,
  execute: approveExpense,
  useSave: () => { const expenses = useContext(ExpenseRepositoryContext); return (change: Change) => expenses.save(change); },
});
export function ApproveExpense() {
  return <Operation operation={approval} />;
}
export function Expenses({ repository, actor }: { repository: ExpenseRepository; actor: Actor }) {
  return <ExpenseRepositoryContext.Provider value={repository}>
    <ActorContext.Provider value={actor}><ApproveExpense /></ActorContext.Provider>
  </ExpenseRepositoryContext.Provider>;
}
