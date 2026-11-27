/** @jsx h */
import { h, createApplication } from 'koyuki/experimental';
import { ok, err, type Result, type ExecutionEvent } from 'koyuki';
import { Expenses, approval, type ExpenseRepository } from './expense.js';
import { ReplayExpenses, replayedApproval, type ReplayExpenseRepository } from './expense-replay.js';
import { BudgetExpenses, budgetApproval } from './expense-budget.js';
import { Leaves, leaveApproval, type LeaveRepository, type LeaveState } from './leave.js';
import type { ExpenseState } from './domain/expenses.js';
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function value<T, E>(result: Result<T, E>): T { if (!result.ok) throw new Error(`UnexpectedFailure:${JSON.stringify(result.error)}`); return result.value; }
const actor = { id: 'boss', role: 'manager', active: true } as const;
const input = { id: 'expense-1', expectedVersion: 1 };
const current = { kind: 'manager', id: input.id, owner: 'owner', amount: 1000, receipt: true, version: 1 } as const;
let loads = 0, saves = 0;
const repository: ExpenseRepository = {
  async load(input, actor) { loads++; return ok({ input, actor, current }); },
  async save(change) { saves++; return ok(change); },
};
const events: ExecutionEvent[] = [];
const app = createApplication(<Expenses repository={repository} actor={actor} />, { observeExecution: event => events.push(event) });
check(loads === 0 && saves === 0, 'assembly executed IO');
const report = await app.inspect(approval, input);
check(value(report.result).next.kind === 'approved', 'expense approval failed');
check(report.trace.some(row => row.step === 'authorize-approval'), 'inner rule trace was lost');
check(events.some(row => row.kind === 'span-started' && row.step === 'approve'), 'live span was lost');

function selectedState(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const state = 'current' in value ? value.current : 'next' in value ? value.next : value;
  return state !== null && typeof state === 'object' && 'kind' in state && typeof state.kind === 'string' ? state.kind : null;
}
const captured = await app.inspect(approval, input, {
  input: (value, step) => ({ step, state: selectedState(value) }),
  result: result => result.ok ? selectedState(result.value) : null,
});
check(captured.observationErrors.length === 0 && captured.observations.some(row => row.step === 'approve' && row.input.state === 'manager' && row.result === 'approved'), 'selected rule capture failed');


let policyReads = 0;
const policies = { async read() { policyReads++; return ok({ approvalLimit: 2000 }); } };
const budgetApp = createApplication(<BudgetExpenses repository={repository} policies={policies} actor={actor} />);
check(policyReads === 0, 'budget policy read during assembly');
const budgetReport = await budgetApp.inspect(budgetApproval, input);
check(value(budgetReport.result).next.kind === 'approved', 'budget approval failed');
check(budgetReport.trace.some(row => row.step === 'read-budget-policy') && budgetReport.trace.some(row => row.step === 'check-budget-policy'), 'middle IO or pure rule trace was lost');

// Single-process demo adapter: CAS and receipt update have no intervening await.
// Production hosts must provide a transactional adapter for this same contract.
let saved: ExpenseState = current;
const receipts = new Map<string, { fingerprint: string; value: ExpenseState }>();
let commits = 0;
const fingerprint = (request: Parameters<ReplayExpenseRepository['receipt']>[0]) => JSON.stringify([
  request.operation, request.actor.id, request.actor.role, request.actor.active, request.input.id, request.input.expectedVersion,
]);
const replayRepository: ReplayExpenseRepository = {
  async load(input, actor) {
    const result = await repository.load(input, actor);
    return result.ok ? result : err({ kind: 'RepositoryUnavailable' });
  },
  receipt(request) {
    const receipt = receipts.get(request.requestId);
    if (!receipt) return ok({ kind: 'missing' });
    if (receipt.fingerprint !== fingerprint(request)) return err({ kind: 'IdempotencyConflict' });
    return ok({ kind: 'found', value: receipt.value });
  },
  async saveRequest(request, change) {
    const found = this.receipt(request);
    const cached = await found;
    if (!cached.ok) return cached;
    if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
    // Recheck after awaiting lookup: the actual mutation and receipt form one synchronous section.
    const winner = receipts.get(request.requestId);
    if (winner) return winner.fingerprint === fingerprint(request)
      ? ok({ kind: 'replayed', value: winner.value }) : err({ kind: 'IdempotencyConflict' });
    if (saved.version !== change.expectedVersion) return err({ kind: 'SaveConflict' });
    saved = change.next;
    receipts.set(request.requestId, { fingerprint: fingerprint(request), value: saved });
    commits++;
    return ok({ kind: 'committed', value: saved });
  },
};
const replayApp = createApplication(<ReplayExpenses repository={replayRepository} actor={actor} />);
const request = { requestId: 'request-1', input };
const first = await replayApp.inspect(replayedApproval, request);
const repeated = await replayApp.inspect(replayedApproval, request);
check(value(first.result).kind === 'committed' && value(repeated.result).kind === 'replayed', 'receipt replay failed');
check(repeated.attempt === null && commits === 1, 'replay repeated business work');
const other = createApplication(<ReplayExpenses repository={replayRepository} actor={{ ...actor, id: 'other' }} />);
const refused = await other.dispatch(replayedApproval, request);
check(!refused.ok && refused.error.kind === 'IdempotencyConflict', 'actor isolation failed');

let leave: LeaveState = { kind: 'pending', id: 'leave-1', owner: 'owner', days: 2 };
const leaves: LeaveRepository = {
  async load(input, actor) { return input.id === leave.id ? ok({ current: leave, actor }) : err('NotFound'); },
  async save(next) { if (leave.kind !== 'pending') return err('SaveConflict'); leave = next; return ok(next); },
};
const selfApprovalApp = createApplication(<Leaves repository={leaves} actor={{ ...actor, id: 'owner' }} />);
const selfApproval = await selfApprovalApp.dispatch(leaveApproval, { id: leave.id });
check(!selfApproval.ok && selfApproval.error === 'SelfApproval' && leave.kind === 'pending', 'leave self-approval was allowed or changed state');
const leaveApp = createApplication(<Leaves repository={leaves} actor={actor} />);
check(value(await leaveApp.dispatch(leaveApproval, { id: leave.id })).kind === 'approved', 'leave approval failed');
const denied = await leaveApp.inspect(leaveApproval, { id: leave.id });
check(!denied.result.ok && denied.result.error === 'AlreadyDecided', 'domain failure was lost');
check(denied.trace.at(-1)?.step === 'authorize-leave', 'failed rule was lost');

if (false) {
  // @ts-expect-error Required request fields must survive the JSX boundary.
  void app.dispatch(approval, { id: 'one' });
  // @ts-expect-error Replay requires a request ID.
  void replayApp.dispatch(replayedApproval, { input });
  // @ts-expect-error The leave operation has a different input contract.
  void leaveApp.dispatch(leaveApproval, { requestId: 'one' });
}
console.log('Verified installed experimental authoring: expense, leave, replay, actor isolation and live rule spans.');
