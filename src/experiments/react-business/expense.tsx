/** @jsx h */
import { workflow, type Result } from '../../framework/index.js';
import { validateApproval, approve, type Actor, type Input, type Loaded, type Change } from '../../expenses/domain.js';
import { h, createContext, useContext, useOperation, Operation, operationKey } from './runtime.js';

// Independently callable pure business calculation. No hooks or repository needed.
export const approveExpense = workflow('authorize-approval', validateApproval).then('approve', approve);
export interface ExpenseRepository {
  load(input: Input, actor: Actor): Promise<Result<Loaded, 'LoadFailed'>>;
  save(change: Change): Promise<Result<Change, 'SaveFailed'>>;
}
export const ExpenseRepositoryContext = createContext<ExpenseRepository>();
export const ActorContext = createContext<Actor>();
const approvalId = 'expense.approve.v1';
export function useActor() { return useContext(ActorContext); }
export function useExpenseApproval() {
  const expenses = useContext(ExpenseRepositoryContext);
  const actor = useActor();
  return useOperation({ name: approvalId,
    load: (input: Input) => expenses.load(input, actor),
    execute: approveExpense,
    save: change => expenses.save(change),
  });
}
export const approval = operationKey(approvalId, useExpenseApproval);
export function ApproveExpense() {
  const handler = useExpenseApproval();
  return <Operation operation={approval} handler={handler} />;
}
export function Expenses({ repository, actor }: { repository: ExpenseRepository; actor: Actor }) {
  return <ExpenseRepositoryContext.Provider value={repository}>
    <ActorContext.Provider value={actor}><ApproveExpense /></ActorContext.Provider>
  </ExpenseRepositoryContext.Provider>;
}
