/** @jsx h */
import { process, workflow, ok, err, type Result } from '../../framework/index.js';
import { validateApproval, approve, type Loaded, type AuthorizedApproval, type Input, type Actor } from '../../expenses/domain.js';
import { h, createContext, useContext, useOperation, Operation, operationKey } from './runtime.js';
import { ActorContext, ExpenseRepositoryContext, useActor, type ExpenseRepository } from './expense.js';
export interface BudgetPolicy { readonly approvalLimit: number }
export interface BudgetPolicyRepository {
  read(context: AuthorizedApproval): Promise<Result<BudgetPolicy, 'BudgetUnavailable'>>;
}
export const BudgetPolicyContext = createContext<BudgetPolicyRepository>();
const checked: unique symbol = Symbol('budget-policy-checked');
export type BudgetPolicyLoaded = AuthorizedApproval & Readonly<{ budget: BudgetPolicy }>;
type WithinBudgetPolicy = BudgetPolicyLoaded & Readonly<{ [checked]: true }>;
function checkBudgetPolicy(context: BudgetPolicyLoaded): Result<WithinBudgetPolicy, 'ApprovalLimitExceeded'> {
  return context.current.amount <= context.budget.approvalLimit
    ? ok({ ...context, [checked]: true }) : err('ApprovalLimitExceeded');
}
const applyApproval = (context: WithinBudgetPolicy) => approve(context);
// Pure business rules remain independently callable, without Context or IO.
export const approveWithBudgetPolicy = workflow('check-budget-policy', checkBudgetPolicy).then('approve', applyApproval);
/** The explicit IO shell composes pure calculations and a policy read. No save here. */
export function budgetApprovalProcess(policies: BudgetPolicyRepository) {
  return process<Loaded>()
    .through(workflow('authorize-approval', validateApproval))
    .effect('read-budget-policy', context => policies.read(context), 'budget')
    .through(approveWithBudgetPolicy);
}
const approvalId = 'expense.approve-with-budget.v1';
export function useBudgetExpenseApproval() {
  const expenses = useContext(ExpenseRepositoryContext);
  const policies = useContext(BudgetPolicyContext);
  const actor = useActor();
  return useOperation({ name: approvalId,
    load: (input: Input) => expenses.load(input, actor),
    execute: budgetApprovalProcess(policies),
    save: change => expenses.save(change),
  });
}
export const budgetApproval = operationKey(approvalId, useBudgetExpenseApproval);
function ApproveBudgetExpense() {
  const handler = useBudgetExpenseApproval();
  return <Operation operation={budgetApproval} handler={handler} />;
}
export function BudgetExpenses({ repository, policies, actor }: { repository: ExpenseRepository; policies: BudgetPolicyRepository; actor: Actor }) {
  return <ExpenseRepositoryContext.Provider value={repository}><BudgetPolicyContext.Provider value={policies}>
    <ActorContext.Provider value={actor}><ApproveBudgetExpense /></ActorContext.Provider>
  </BudgetPolicyContext.Provider></ExpenseRepositoryContext.Provider>;
}
