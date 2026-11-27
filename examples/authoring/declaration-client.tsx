/** @jsx h */
import { h, createApplication } from 'koyuki/experimental';
import type { Result, Execution, ReplayInputError, ReplayReport, StepObservation } from 'koyuki';
import { captureExpense, captureReplayedExpense } from './declarations/captured-exports.js';
import { Expenses, approval, type ExpenseRepository } from './declarations/expense.js';
import { BudgetExpenses, budgetApproval, type BudgetPolicyRepository } from './declarations/expense-budget.js';
import { ReplayExpenses, replayedApproval, type ReplayExpenseRepository, type ReplayStorageError } from './declarations/expense-replay.js';
import type { Actor, Change, ExpenseState, RuleError } from './declarations/domain/expenses.js';
import { Leaves, leaveApproval, type LeaveRepository } from './declarations/leave.js';
import type { AuthorizedLeave, LeaveApprover, ApprovedLeave } from './declarations/leave-domain.js';
import type { LoadError } from './declarations/domain/repository.js';
import { createBusinessApplication, replayedLeaveApproval, registrationRequest, registrationConfirmation } from './declarations/three-businesses.js';
import type { Registration, RuleError as RegistrationRuleError } from './declarations/domain/registration.js';
import type { RegistrationStorageError } from './declarations/registration.js';
import type { LeaveStorageError } from './declarations/leave-replay.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export function checkThreeBusinesses(ports: Parameters<typeof createBusinessApplication>[0]) {
  const app = createBusinessApplication(ports);
  const leave = app.dispatch(replayedLeaveApproval, { requestId: 'one', input: { id: 'one' } });
  const registration = app.dispatch(registrationRequest, { requestId: 'two', id: 'two', email: 'two@example.test' });
  const exactLeave: Equal<typeof leave, Promise<Result<Execution<ApprovedLeave>, LeaveStorageError | 'AlreadyDecided' | 'Forbidden' | 'SelfApproval' | ReplayInputError>>> = true;
  const exactRegistration: Equal<typeof registration, Promise<Result<Execution<Registration>, RegistrationStorageError | RegistrationRuleError | ReplayInputError>>> = true;
  if (false) {
    // @ts-expect-error A registration payload cannot stand in for a confirmation token.
    void app.dispatch(registrationConfirmation, { requestId: 'three', id: 'two', email: 'two@example.test' });
  }
  return { exactLeave, exactRegistration };
}
export function checkDeclarations(repository: ExpenseRepository, replayRepository: ReplayExpenseRepository, actor: Actor, policies: BudgetPolicyRepository, leaves: LeaveRepository) {
  const app = createApplication(<Expenses repository={repository} actor={actor} />);
  const result = app.dispatch(approval, { id: 'one', expectedVersion: 1 });
  const exact: Equal<typeof result, Promise<Result<Change, RuleError | 'LoadFailed' | 'SaveFailed'>>> = true;
  const captured = app.inspect(approval, { id: 'one', expectedVersion: 1 }, { input: (_value, step) => ({ step }), result: result => result.ok });
  type Captured = Awaited<typeof captured>;
  const exactCapturedInput: Equal<Captured['observations'], readonly StepObservation<{ step: string }, boolean>[]> = true;
  const exactCapturedResult: Equal<Captured['result'], Result<Change, RuleError | 'LoadFailed' | 'SaveFailed'>> = true;
  const replay = createApplication(<ReplayExpenses repository={replayRepository} actor={actor} />);
  const report = replay.inspect(replayedApproval, { requestId: 'one', input: { id: 'one', expectedVersion: 1 } });
  const exactReport: Equal<typeof report, Promise<ReplayReport<ExpenseState, LoadError | RuleError | ReplayStorageError, ReplayStorageError>>> = true;
  const capturedReplay = replay.inspect(replayedApproval, { requestId: 'one', input: { id: 'one', expectedVersion: 1 } }, { input: () => null, result: result => result.ok });
  const exactCapturedReplay: Equal<Awaited<typeof capturedReplay>['result'], Result<Execution<ExpenseState>, LoadError | RuleError | ReplayStorageError | ReplayInputError>> = true;
  const exactCapturedAttempt: Equal<Awaited<typeof capturedReplay>['attempt'], ReplayReport<ExpenseState, LoadError | RuleError | ReplayStorageError, ReplayStorageError>['attempt']> = true;
  const replayResult = replay.dispatch(replayedApproval, { requestId: 'one', input: { id: 'one', expectedVersion: 1 } });
  const exactReplayResult: Equal<typeof replayResult, Promise<Result<Execution<ExpenseState>, LoadError | RuleError | ReplayStorageError | ReplayInputError>>> = true;
  if (false) {
    // @ts-expect-error Missing required version must still fail after declaration emit.
    void app.dispatch(approval, { id: 'one' });
  }
  const budget = createApplication(<BudgetExpenses repository={repository} policies={policies} actor={actor} />);
  const budgetResult = budget.dispatch(budgetApproval, { id: 'one', expectedVersion: 1 });
  const exactBudget: Equal<typeof budgetResult, Promise<Result<Change, RuleError | 'LoadFailed' | 'SaveFailed' | 'BudgetUnavailable' | 'ApprovalLimitExceeded'>>> = true;
  const exported = captureExpense(repository, actor, { id: 'one', expectedVersion: 1 });
  const exactExported: Equal<Awaited<typeof exported>['observations'], readonly StepObservation<{ step: string }, boolean>[]> = true;
  const exportedReplay = captureReplayedExpense(replayRepository, actor, { requestId: 'one', input: { id: 'one', expectedVersion: 1 } });
  const exactExportedReplay: Equal<Awaited<typeof exportedReplay>['result'], Result<Execution<ExpenseState>, LoadError | RuleError | ReplayStorageError | ReplayInputError>> = true;
  const leave = createApplication(<Leaves repository={leaves} actor={actor} />);
  const leaveResult = leave.dispatch(leaveApproval, { id: 'one' });
  const exactLeaveResult: Equal<typeof leaveResult, Promise<Result<ApprovedLeave, 'AlreadyDecided' | 'Forbidden' | 'SelfApproval' | 'NotFound' | 'SaveConflict'>>> = true;
  const exactApprover: Equal<AuthorizedLeave['actor'], LeaveApprover> = true;
  const exactRole: Equal<AuthorizedLeave['actor']['role'], 'manager'> = true;
  const exactActive: Equal<AuthorizedLeave['actor']['active'], true> = true;
  return { exactLeaveResult, exactApprover, exactRole, exactActive, exactExported, exactExportedReplay, exact, exactReport, exactReplayResult, exactBudget, exactCapturedInput, exactCapturedResult, exactCapturedReplay, exactCapturedAttempt };
}
