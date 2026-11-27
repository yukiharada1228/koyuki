/** @jsx h */
import { h, createApplication } from 'koyuki/experimental';
import type { Result, Execution, ReplayInputError, ReplayReport } from 'koyuki';
import { Expenses, approval, type ExpenseRepository } from './declarations/expense.js';
import { ReplayExpenses, replayedApproval, type ReplayExpenseRepository, type ReplayStorageError } from './declarations/expense-replay.js';
import type { Actor, Change, ExpenseState, RuleError } from './declarations/domain/expenses.js';
import type { LoadError } from './declarations/domain/repository.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export function checkDeclarations(repository: ExpenseRepository, replayRepository: ReplayExpenseRepository, actor: Actor) {
  const app = createApplication(<Expenses repository={repository} actor={actor} />);
  const result = app.dispatch(approval, { id: 'one', expectedVersion: 1 });
  const exact: Equal<typeof result, Promise<Result<Change, RuleError | 'LoadFailed' | 'SaveFailed'>>> = true;
  const replay = createApplication(<ReplayExpenses repository={replayRepository} actor={actor} />);
  const report = replay.inspect(replayedApproval, { requestId: 'one', input: { id: 'one', expectedVersion: 1 } });
  const exactReport: Equal<typeof report, Promise<ReplayReport<ExpenseState, LoadError | RuleError | ReplayStorageError, ReplayStorageError>>> = true;
  const replayResult = replay.dispatch(replayedApproval, { requestId: 'one', input: { id: 'one', expectedVersion: 1 } });
  const exactReplayResult: Equal<typeof replayResult, Promise<Result<Execution<ExpenseState>, LoadError | RuleError | ReplayStorageError | ReplayInputError>>> = true;
  if (false) {
    // @ts-expect-error Missing required version must still fail after declaration emit.
    void app.dispatch(approval, { id: 'one' });
  }
  return { exact, exactReport, exactReplayResult };
}
