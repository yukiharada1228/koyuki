import { ok, err, workflow, bindMutation, defineAction, type Result } from 'koyuki';

export interface Expense { readonly id: string; readonly amount: number; readonly receipt: boolean; readonly employeeActive: boolean }
declare const validated: unique symbol;
export type ValidExpense = Readonly<Expense & { employeeActive: true }> & { readonly [validated]: true };
export type ReceiptedExpense = ValidExpense & { readonly receipt: true };
export type ExpenseDecision =
  | Readonly<{ expense: ValidExpense; route: 'automatic' }>
  | Readonly<{ expense: ReceiptedExpense; route: 'manager' }>
  | Readonly<{ expense: ReceiptedExpense; route: 'manager-and-finance' }>;
export type ExpenseError = { kind: 'InvalidAmount' } | { kind: 'InactiveEmployee' } | { kind: 'ReceiptRequired' };
const validate = (expense: Expense): Result<ValidExpense, ExpenseError> => {
  if (!Number.isSafeInteger(expense.amount) || expense.amount <= 0) return err({ kind: 'InvalidAmount' });
  if (!expense.employeeActive) return err({ kind: 'InactiveEmployee' });
  return ok(Object.freeze({ ...expense }) as ValidExpense);
};
const receipt = workflow('require-receipt', (expense: ValidExpense): Result<ReceiptedExpense, ExpenseError> =>
  expense.receipt ? ok(Object.freeze({ ...expense, receipt: true as const })) : err({ kind: 'ReceiptRequired' }));
const automatic = workflow('automatic', (expense: ValidExpense) =>
  ok(Object.freeze({ expense, route: 'automatic' as const })));
const approval = <R extends 'manager' | 'manager-and-finance'>(route: R) => workflow(route, (expense: ReceiptedExpense) =>
  ok(Object.freeze({ expense, route })));

// These are approval requirements, not declarations that a human has already approved.
export const expenseWorkflow = workflow('validate-expense', validate)
  .branch('amount-at-most-3000', expense => expense.amount <= 3000, {
    yes: automatic,
    no: receipt.branch('amount-at-most-100000', expense => expense.amount <= 100000, {
      yes: approval('manager'), no: approval('manager-and-finance'),
    }),
  });
