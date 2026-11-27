/** @jsx h */
import { err, ok } from '../../framework/index.js';
import { h, Fragment, createContext, useContext, defineResource, defineEvent, emit, defineOperation, Operation, On } from '../../framework/authoring.js';
import { restoreExpense, type Actor, type ExpenseState } from '../../expenses/domain.js';
import { budgetedSubmission, budgetedApproval, budgetedReturn, budgetedEdit, parseRequest, type Action, type Request, type BudgetChange, type DomainError } from './domain.js';
import type { Repository, StorageError, Identity } from './repository.js';
export const Expenses = createContext<Repository>();
export const ActorContext = createContext<Actor>();
export const expenseChanged = defineEvent<ExpenseState>('expense-budget.changed.v1', { decode: restoreExpense });
function useLoad<A extends Action>(action: A) {
  const repository = useContext(Expenses), actor = Object.freeze({ ...useContext(ActorContext) });
  return (input: Request<A>) => {
    const parsed = parseRequest(action, input);
    return parsed.ok ? repository.load(parsed.value, actor) : Promise.resolve(parsed);
  };
}
function boundary(action: Action) {
  function useIdentity(): Identity { return { action, actor: Object.freeze({ ...useContext(ActorContext) }) }; }
  return {
    emits: [emit(expenseChanged, (change: BudgetChange) => change.expense.next)],
    useSave: () => {
      const repository = useContext(Expenses), identity = useIdentity();
      return (change: BudgetChange, request: Request, events: Parameters<Repository['save']>[3]) => repository.save(change, request, identity, events);
    },
    useReplay: () => {
      const repository = useContext(Expenses), identity = useIdentity();
      return { lookup: (input: Request) => {
        const parsed = parseRequest(action, input);
        return parsed.ok ? repository.receipt(parsed.value, identity) : Promise.resolve(parsed);
      }, resolveAfter: (error: DomainError | StorageError) => error.kind === 'Conflict' || error.kind === 'StorageFailed' };
    },
  };
}
const submissionContext = defineResource('expense-budget.submit.context', () => useLoad('submit'));
const approvalContext = defineResource('expense-budget.approve.context', () => useLoad('approve'));
const correctionContext = defineResource('expense-budget.return.context', () => useLoad('return'));
const editingContext = defineResource('expense-budget.edit.context', () => useLoad('edit'));
export const submission = defineOperation('expense-budget.submit.v1', { needs: submissionContext, execute: budgetedSubmission, ...boundary('submit') });
export const approval = defineOperation('expense-budget.approve.v1', { needs: approvalContext, execute: budgetedApproval, ...boundary('approve') });
export const correction = defineOperation('expense-budget.return.v1', { needs: correctionContext, execute: budgetedReturn, ...boundary('return') });
export const editing = defineOperation('expense-budget.edit.v1', { needs: editingContext, execute: budgetedEdit, ...boundary('edit') });
export function ExpenseBusiness({ repository }: { repository: Repository }) {
  return <Expenses.Provider value={repository}><Fragment>
    <Operation operation={submission} /><Operation operation={approval} />
    <Operation operation={correction} /><Operation operation={editing} />
  </Fragment></Expenses.Provider>;
}
export interface Sink { send(expense: ExpenseState): Promise<ReturnType<typeof ok<null>> | ReturnType<typeof err<'Unavailable'>>> }
const Notifications = createContext<Sink>();
const eventInput = defineResource('expense-budget.event', () => (input: ExpenseState) => ok(input));
export const notification = defineOperation('expense-budget.notify.v1', { needs: eventInput, execute: (input: ExpenseState) => ok(input), useSave: () => { const sink = useContext(Notifications); return (expense: ExpenseState) => sink.send(expense); } });
export function ExpenseNotifications({ sink }: { sink: Sink }) { return <Notifications.Provider value={sink}><On event={expenseChanged} operation={notification} /></Notifications.Provider>; }
