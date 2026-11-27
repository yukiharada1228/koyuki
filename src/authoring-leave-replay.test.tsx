/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { h, Fragment, createApplication } from './framework/authoring.js';
import { ReplayLeaves, replayedLeaveApproval } from './experiments/react-business/leave-replay.js';
import { SqliteReplayLeaves } from './experiments/react-business/leave-sqlite.js';
import { Registrations, registrationRequest } from './experiments/react-business/registration.js';
import { ReplayRegistrationRepository } from './registration/replay-repository.js';
import { ReplayExpenses, replayedApproval } from './experiments/react-business/expense-replay.js';
import { ReplaySqliteExpenses } from './expenses/sqlite-replay.js';
import { draftExpense } from './expenses/domain.js';
import { expenseReplayCommands } from './expenses/replay.js';
import type { Actor } from './expenses/domain.js';
import { ok, err, type ExecutionEvent } from './framework/index.js';
const manager = { id: 'boss', role: 'manager', active: true } as const;
const pending = { kind: 'pending', id: 'holiday', owner: 'employee', days: 3 } as const;
const request = { requestId: 'approve-holiday', input: { id: 'holiday' } };
test('leave approval persists its replay boundary across mounts and storage connections', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-leave-replay-')), path = join(directory, 'leave.db');
  let repository = new SqliteReplayLeaves(path);
  try {
    repository.seed(pending);
    const events: ExecutionEvent[] = [];
    const actor: { -readonly [K in keyof Actor]: Actor[K] } = { ...manager };
    const app = createApplication(<ReplayLeaves repository={repository} actor={actor} />, { observeExecution: event => events.push(event) });
    actor.id = 'changed-after-mount'; actor.active = false;
    const first = await app.inspect(replayedLeaveApproval, request, { input: (_value, step) => step, result: result => result.ok });
    assert.deepEqual(first.result, ok({ kind: 'committed', value: { ...pending, kind: 'approved', by: 'boss' } }));
    assert(first.observations.some(row => row.step === 'approve-leave'));
    assert(events.some(event => event.kind === 'completed' && event.status === 'ok'));
    repository.close(); repository = new SqliteReplayLeaves(path);
    const resumed = createApplication(<ReplayLeaves repository={repository} actor={manager} />);
    const replay = await resumed.inspect(replayedLeaveApproval, request);
    assert.equal(replay.result.ok && replay.result.value.kind, 'replayed'); assert.equal(replay.attempt, null);
    const other = createApplication(<ReplayLeaves repository={repository} actor={{ ...manager, id: 'other' }} />);
    assert.deepEqual(await other.dispatch(replayedLeaveApproval, request), err('IdempotencyConflict'));
    if (false) {
      // @ts-expect-error Replay does not weaken the business request contract.
      void resumed.dispatch(replayedLeaveApproval, { requestId: 'missing' });
    }
  } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('leave state and receipt roll back together, then concurrent retry commits once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-leave-atomic-')), path = join(directory, 'leave.db');
  const first = new SqliteReplayLeaves(path), second = new SqliteReplayLeaves(path), db = new DatabaseSync(path);
  try {
    first.seed(pending);
    const app = createApplication(<ReplayLeaves repository={first} actor={manager} />);
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON leave_receipts BEGIN SELECT RAISE(ABORT,'failure'); END");
    assert.deepEqual(await app.dispatch(replayedLeaveApproval, request), err('StorageUnavailable'));
    assert.deepEqual(await first.load(request.input, manager), ok({ current: pending, actor: manager }));
    db.exec('DROP TRIGGER fail_receipt');
    const other = createApplication(<ReplayLeaves repository={second} actor={manager} />);
    const results = await Promise.all([app.dispatch(replayedLeaveApproval, request), other.dispatch(replayedLeaveApproval, request)]);
    assert.deepEqual(results.map(result => result.ok && result.value.kind).sort(), ['committed', 'replayed']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM leave_receipts').get()?.n, 1);
  } finally { first.close(); second.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('sibling business components have independent Providers and concurrent executions', async () => {
  const leaves = new SqliteReplayLeaves(':memory:'), registrations = new ReplayRegistrationRepository(':memory:'), expenses = new ReplaySqliteExpenses(':memory:');
  try {
    leaves.seed(pending);
    const draft = draftExpense({ id: 'expense', owner: 'owner', amount: 20000, receipt: true });
    assert(draft.ok); if (!draft.ok) throw new Error('ExpectedDraft');
    assert(expenses.insertDraft(draft.value).ok);
    assert((await expenseReplayCommands(expenses, { id: 'owner', role: 'employee', active: true }).submit.run({ requestId: 'submit-expense', input: { id: 'expense', expectedVersion: 1 } })).ok);
    const events: ExecutionEvent[] = [];
    const app = createApplication(<Fragment>
      <ReplayExpenses repository={expenses} actor={manager} />
      <ReplayLeaves repository={leaves} actor={manager} />
      <Registrations repository={registrations} actor={{ id: 'signup-session', role: 'employee', active: true }} />
    </Fragment>, { sessionId: 'siblings', observeExecution: event => events.push(event) });
    const results = await Promise.all([
      app.dispatch(replayedApproval, { requestId: 'approve-expense', input: { id: 'expense', expectedVersion: 2 } }),
      app.dispatch(replayedLeaveApproval, request),
      app.dispatch(registrationRequest, { requestId: 'register', id: 'person', email: 'person@example.test' }),
    ]);
    assert(results.every(result => result.ok && result.value.kind === 'committed'));
    assert.deepEqual(await leaves.load(request.input, manager), ok({ current: { ...pending, kind: 'approved', by: 'boss' }, actor: manager }));
    assert.equal(events.filter(event => event.kind === 'completed').length, 3);
    assert.equal(new Set(events.map(event => event.executionId)).size, 3);
  } finally { expenses.close(); leaves.close(); registrations.close(); }
});
