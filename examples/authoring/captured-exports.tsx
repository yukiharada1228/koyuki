/** @jsx h */
import { h, createApplication } from 'koyuki/experimental';
import { Expenses, approval, type ExpenseRepository } from './expense.js';
import { ReplayExpenses, replayedApproval, type ReplayExpenseRepository, type ApprovalRequest } from './expense-replay.js';
import type { Actor, Input } from './domain/expenses.js';
// No final API return annotations: the package must provide portable inferred names.
export function captureExpense(repository: ExpenseRepository, actor: Actor, input: Input) {
  const app = createApplication(<Expenses repository={repository} actor={actor} />);
  return app.executeDetailed(approval, input, { input: (_value, step) => ({ step }), result: result => result.ok });
}
export function captureReplayedExpense(repository: ReplayExpenseRepository, actor: Actor, request: ApprovalRequest) {
  const app = createApplication(<ReplayExpenses repository={repository} actor={actor} />);
  return app.executeDetailed(replayedApproval, request, { input: (_value, step) => step, result: result => result.ok });
}
