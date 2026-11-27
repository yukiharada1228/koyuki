/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createApplication, defineOperation } from './experiments/react-business/runtime.js';
import { ReplayExpenses, replayedApproval, type ReplayExpenseRepository, type ReplayStorageError as HookStorageError } from './experiments/react-business/expense-replay.js';
import { ReplaySqliteExpenses, type ExpenseRequest, type ReplayStorageError } from './expenses/sqlite-replay.js';
import { expenseReplayCommands } from './expenses/replay.js';
import { draftExpense, type Actor, type Change, type ExpenseState, type RuleError } from './expenses/domain.js';
import { ok, err, type Result, type Execution, type ReplayReport, type ReplayInputError, type ExecutionEvent } from './framework/index.js';
import type { LoadError } from './expenses/repository.js';
import { approveExpense } from './experiments/react-business/expense.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Hook = ReturnType<typeof replayedApproval.use>;
type HookResult = Assert<Equal<Awaited<ReturnType<Hook['run']>>, Result<Execution<ExpenseState>, LoadError | RuleError | HookStorageError | ReplayInputError>>>;
type HookReport = Assert<Equal<Awaited<ReturnType<Hook['runDetailed']>>, ReplayReport<ExpenseState, LoadError | RuleError | HookStorageError, HookStorageError>>>;
const employee: Actor = { id: 'owner', active: true, role: 'employee' };
const manager: Actor = { id: 'boss', active: true, role: 'manager' };
function value<T, E>(result: Result<T, E>): T { assert.equal(result.ok, true); if (!result.ok) throw new Error('ExpectedSuccess'); return result.value; }
async function seed(repository: ReplaySqliteExpenses, id = 'one') {
  value(repository.insertDraft(value(draftExpense({ id, owner: employee.id, amount: 20000, receipt: true }))));
  value(await expenseReplayCommands(repository, employee).submit.run({ requestId: `seed-${id}`, input: { id, expectedVersion: 1 } }));
}
const call = { requestId: 'approval', input: { id: 'one', expectedVersion: 2 } };
function counted(repository: ReplaySqliteExpenses, calls: string[], pause?: () => Promise<void>): ReplayExpenseRepository {
  return {
    async load(input, actor) { calls.push(`load:${actor.id}`); await pause?.(); return repository.load(input, actor); },
    receipt(request) { calls.push(`lookup:${request.actor.id}`); return repository.receipt(request); },
    saveRequest(request, change) { calls.push(`save:${request.actor.id}`); return repository.saveRequest(request, change); },
  };
}
test('Hooks use the atomic receipt adapter and retain domain step traces; replay skips all business work', async t => {
  const repository = new ReplaySqliteExpenses(':memory:'); t.after(() => repository.close()); await seed(repository);
  const calls: string[] = [];
  const events: ExecutionEvent[] = [];
  const app = createApplication(<ReplayExpenses repository={counted(repository, calls)} actor={manager} />, { sessionId: 'replay-jsx', observeExecution: event => events.push(event) });
  assert.deepEqual(calls, []);
  const sent = structuredClone(call);
  const pending = app.executeDetailed(replayedApproval, sent);
  sent.input.expectedVersion = 99;
  const first = await pending;
  assert.equal(value(first.result).kind, 'committed');
  assert.deepEqual(first.attempt?.trace?.map(row => row.step), ['expense.approve.v1:load', 'authorize-approval', 'approve', 'expense.approve.v1']);
  assert.deepEqual(calls, ['lookup:boss', 'load:boss', 'save:boss']);
  assert.equal(events.some(event => event.kind === 'span-started' && event.step === 'authorize-approval'), true);
  assert.equal(events.some(event => event.kind === 'span-started' && event.step === 'replay.lookup:before'), true);
  events.length = 0;
  const observedReplay = await app.executeDetailed(replayedApproval, call);
  assert.equal(value(observedReplay.result).kind, 'replayed');
  assert.equal(events.some(event => event.kind === 'span-started' && event.step === 'authorize-approval'), false);
  assert.equal(events.some(event => event.kind === 'completed' && event.status === 'ok'), true);
  calls.length = 0;
  // A new request-scoped tree can find the same persisted receipt.
  const another = createApplication(<ReplayExpenses repository={counted(repository, calls)} actor={manager} />);
  const replay = await another.executeDetailed(replayedApproval, call);
  assert.equal(value(replay.result).kind, 'replayed');
  assert.deepEqual(value(first.result).value, value(replay.result).value);
  assert.equal(replay.attempt, null);
  assert.deepEqual(calls, ['lookup:boss']);
  assert.equal(value(repository.read('one')).version, 3);
  calls.length = 0;
  assert.deepEqual(await another.execute(replayedApproval, { ...call, input: { ...call.input, expectedVersion: 3 } }), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(calls, ['lookup:boss']);
  if (false) {
    // @ts-expect-error Request identity is mandatory for replay.
    void app.execute(replayedApproval, { input: call.input });
  }
});
test('domain failure exposes the exact failing rule and never saves', async t => {
  const repository = new ReplaySqliteExpenses(':memory:'); t.after(() => repository.close()); await seed(repository);
  const calls: string[] = [];
  const app = createApplication(<ReplayExpenses repository={counted(repository, calls)} actor={employee} />);
  const report = await app.executeDetailed(replayedApproval, call);
  assert.deepEqual(report.result, err({ kind: 'SelfApproval' }));
  assert.deepEqual(report.attempt?.trace, [
    { step: 'expense.approve.v1:load', status: 'ok' }, { step: 'authorize-approval', status: 'error' },
  ]);
  assert.deepEqual(calls, ['lookup:owner', 'load:owner']);
  assert.equal(value(repository.read('one')).version, 2);
});
test('overlapping requests with an identical key cannot read another actor receipt', async t => {
  const repository = new ReplaySqliteExpenses(':memory:'); t.after(() => repository.close()); await seed(repository);
  const calls: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const mutableActor = { ...manager };
  const first = createApplication(<ReplayExpenses repository={counted(repository, calls, () => wait)} actor={mutableActor} />);
  mutableActor.id = 'changed-after-mount';
  const running = first.execute(replayedApproval, call);
  // Both initial lookups can miss; the blocked manager still retains its own actor.
  const other = createApplication(<ReplayExpenses repository={counted(repository, calls)} actor={employee} />);
  assert.deepEqual(await other.execute(replayedApproval, call), err({ kind: 'SelfApproval' }));
  release(); assert.equal(value(await running).kind, 'committed');
  calls.length = 0;
  assert.deepEqual(await other.execute(replayedApproval, call), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(calls, ['lookup:owner']);
  assert.equal(value(repository.read('one')).version, 3);
});
test('concurrent duplicates commit once and recover a lost commit response through the receipt', async t => {
  class LostResponse extends ReplaySqliteExpenses {
    commits = 0;
    override async saveRequest(request: ExpenseRequest, change: Change): Promise<Result<Execution<ExpenseState>, ReplayStorageError>> {
      const result = await super.saveRequest(request, change);
      if (result.ok && result.value.kind === 'committed') this.commits++;
      return result.ok ? err({ kind: 'RepositoryUnavailable' }) : result;
    }
  }
  const repository = new LostResponse(':memory:'); t.after(() => repository.close()); await seed(repository); repository.commits = 0;
  const app = createApplication(<ReplayExpenses repository={repository} actor={manager} />);
  const reports = await Promise.all([app.executeDetailed(replayedApproval, call), app.executeDetailed(replayedApproval, call)]);
  assert.equal(reports.every(report => value(report.result).kind === 'replayed'), true);
  assert.equal(reports.some(report => report.trace.some(row => row.kind === 'lookup' && row.phase === 'after-error' && row.status === 'found')), true);
  assert.equal(repository.commits, 1);
  assert.equal(value(repository.read('one')).version, 3);
});

// Unreachable type checks: replay cannot quietly accept a non-atomic plain save.
function InvalidReplay() {
  if (false) {
    // @ts-expect-error A replay-enabled save must return Execution<Output>.
    defineOperation('bad', () => ({ load: async (_input: string) => ok(1), execute: (input: number) => ok(input), save: async (input: number) => ok(input), replay: { lookup: (_input: string) => ok({ kind: 'missing' as const }), resolveAfter: () => false } }));
    // @ts-expect-error Workflow objects must also accept the actual load output.
    defineOperation('bad-domain', () => ({ load: async (_input: string) => ok(1), execute: approveExpense, save: async (change: Change) => ok(change) }));
  }
}
void InvalidReplay;

test('different requests on one Hook retain their own request envelope through asynchronous execution', async t => {
  const repository = new ReplaySqliteExpenses(':memory:'); t.after(() => repository.close());
  await seed(repository); await seed(repository, 'two');
  const app = createApplication(<ReplayExpenses repository={repository} actor={manager} />);
  const requests = [call, { requestId: 'second-approval', input: { id: 'two', expectedVersion: 2 } }];
  const results = await Promise.all(requests.map(request => app.execute(replayedApproval, request)));
  assert.deepEqual(results.map(result => value(result).value.id), ['one', 'two']);
  for (const request of requests) {
    assert.equal(value(await app.execute(replayedApproval, request)).kind, 'replayed');
    assert.equal(value(repository.read(request.input.id)).version, 3);
  }
});
