/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { h, Fragment, createApplication } from './framework/authoring.js';
import { ReplayExpenses } from './experiments/react-business/expense-replay.js';
import { ReplayLeaves } from './experiments/react-business/leave-replay.js';
import { Registrations } from './experiments/react-business/registration.js';
import { businessDashboard } from './experiments/react-business/dashboard.js';
import { SqliteReplayLeaves } from './experiments/react-business/leave-sqlite.js';
import { ReplaySqliteExpenses } from './expenses/sqlite-replay.js';
import { ReplayRegistrationRepository } from './registration/replay-repository.js';
import { draftExpense, type Actor } from './expenses/domain.js';
import { expenseReplayCommands } from './expenses/replay.js';
const boss = { id: 'boss', role: 'manager', active: true } as const;
const signup = { id: 'signup', role: 'employee', active: true } as const;
const register = { requestId: 'register-one', id: 'person', email: 'person@example.test' };
const expense = { requestId: 'approve-one', input: { id: 'expense', expectedVersion: 2 } };
const leave = { requestId: 'approve-holiday', input: { id: 'holiday' } };
async function fixture(directory?: string) {
  const expenses = new ReplaySqliteExpenses(directory ? join(directory, 'expenses.db') : ':memory:'), leaves = new SqliteReplayLeaves(directory ? join(directory, 'leaves.db') : ':memory:'), registrations = new ReplayRegistrationRepository(directory ? join(directory, 'registrations.db') : ':memory:');
  const draft = draftExpense({ id: 'expense', owner: 'employee', amount: 20000, receipt: true }); assert(draft.ok);
  assert(expenses.insertDraft(draft.value).ok);
  assert((await expenseReplayCommands(expenses, { id: 'employee', role: 'employee', active: true }).submit.run({ requestId: 'seed', input: { id: 'expense', expectedVersion: 1 } })).ok);
  leaves.seed({ kind: 'pending', id: 'holiday', owner: 'employee', days: 3 });
  const app = (actor: Actor = signup) => createApplication(<Fragment><ReplayExpenses repository={expenses} actor={boss} /><ReplayLeaves repository={leaves} actor={boss} /><Registrations repository={registrations} actor={actor} /></Fragment>);
  const screen = businessDashboard({ expenseId: 'expense', leaveId: 'holiday', registrationRequest: register });
  return { app, screen, expenses, leaves, registrations, close() { expenses.close(); leaves.close(); registrations.close(); } };
}
test('expense, leave and registration share declarative operations, authorized queries, durable events and automatic views', async () => {
  const f = await fixture();
  try {
    const app = f.app(), session = await app.start(f.screen);
    assert.equal(session.snapshot().view.expense?.kind, 'manager'); assert.equal(session.snapshot().view.leave?.kind, 'pending'); assert.equal(session.snapshot().view.registration, null);
    const changes: boolean[] = []; session.subscribe(snapshot => changes.push(snapshot.view.busy));
    assert((await session.dispatch({ type: 'approveExpense', input: expense })).ok);
    assert.equal(session.snapshot().view.expense?.kind, 'approved');
    assert((await session.dispatch({ type: 'approveLeave', input: leave })).ok);
    assert.equal(session.snapshot().view.leave?.kind, 'approved');
    assert((await session.dispatch({ type: 'register', input: register })).ok);
    assert.equal(session.snapshot().view.registration?.kind, 'awaiting');
    const email = await f.registrations.claim(0, 100); assert(email.ok);
    const confirmation = { requestId: 'confirmation', id: 'person', token: email.value.event.token, now: 20 };
    assert((await session.dispatch({ type: 'confirmRegistration', input: confirmation })).ok);
    assert.equal(session.snapshot().view.registration?.kind, 'confirmed');
    assert.equal(JSON.stringify(session.snapshot().view).includes('tokenDigest'), false);
    assert.equal(JSON.stringify(session.snapshot().view).includes(email.value.event.token), false);
    assert.equal(f.expenses.events.pending().length, 1); assert.equal(f.leaves.events.pending().length, 1); assert.equal(f.registrations.events.pending().length, 2);
    assert.deepEqual([...f.expenses.events.pending(), ...f.leaves.events.pending(), ...f.registrations.events.pending()].map(event => ({ type: event.type, payload: event.payload })), [
      { type: 'expense.changed.v1', payload: { id: 'expense' } },
      { type: 'leave.changed.v1', payload: { id: 'holiday' } },
      { type: 'registration.changed.v1', payload: { id: 'person' } },
      { type: 'registration.changed.v1', payload: { id: 'person' } },
    ]);

    const before = session.snapshot().view;
    await session.dispatch({ type: 'register', input: register });
    assert.deepEqual(session.snapshot().view, before); // Old awaiting receipt must not overwrite confirmed read model.
    assert.equal(f.registrations.events.pending().length, 2);
    assert(changes.includes(true)); assert.equal(changes.at(-1), false);
    if (false) {
      // @ts-expect-error Each operation preserves its own request type.
      void session.dispatch({ type: 'confirmRegistration', input: register });
    }
  } finally { f.close(); }
});
test('query identity is isolated and read failures do not grant access or turn committed operations into failures', async () => {
  const f = await fixture();
  try {
    const session = await f.app().start(f.screen);
    await session.dispatch({ type: 'register', input: register });
    const other = await f.app({ ...signup, id: 'other' }).start(f.screen);
    assert.equal(other.snapshot().view.registration, null);
    const status = other.snapshot().view.queries.registration;
    assert.equal(status.kind, 'failed'); if (status.kind === 'failed') assert.deepEqual(status.error, { kind: 'IdempotencyConflict' });
    f.registrations.close();
    const refreshed = await session.refresh(); assert(refreshed.ok);
    assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().view.registration?.kind, 'awaiting');
    assert.equal(session.snapshot().view.queries.registration.kind, 'failed');
  } finally { f.expenses.close(); f.leaves.close(); /* registration already closed */ }
});
test('each business rolls state, receipt and declared events back together when outbox insertion fails', async () => {
  const f = await fixture();
  try {
    const session = await f.app().start(f.screen);
    for (const [adapter, event, field, before, after] of [
      [f.expenses, { type: 'approveExpense', input: expense }, 'expense', 'manager', 'approved'],
      [f.leaves, { type: 'approveLeave', input: leave }, 'leave', 'pending', 'approved'],
      [f.registrations, { type: 'register', input: register }, 'registration', undefined, 'awaiting'],
    ] as const) {
      const db = Reflect.get(adapter, 'db') as import('node:sqlite').DatabaseSync;
      db.exec("CREATE TRIGGER reject_business_event BEFORE INSERT ON business_events BEGIN SELECT RAISE(ABORT,'event write failed'); END");
      const result = await session.dispatch(event); assert(result.ok);
      assert.equal(session.snapshot().state.kind, 'failed');
      assert.equal(session.snapshot().view[field]?.kind, before);
      assert.equal(adapter.events.pending().length, 0);
      if (adapter === f.registrations) assert.equal(db.prepare('SELECT count(*) AS n FROM email_outbox').get()?.n, 0);
      db.exec('DROP TRIGGER reject_business_event');
      await session.dispatch({ type: 'dismiss' }); await session.dispatch(event);
      assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().view[field]?.kind, after);
      assert.equal(adapter.events.pending().length, 1);
    }
  } finally { f.close(); }
});

test('all three persisted events survive reconnection and refresh a session without re-running committed operations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-dashboard-restart-'));
  const f = await fixture(directory); let closed = false;
  let expenses: ReplaySqliteExpenses | undefined, leaves: SqliteReplayLeaves | undefined, registrations: ReplayRegistrationRepository | undefined;
  try {
    const first = await f.app().start(f.screen);
    await first.dispatch({ type: 'approveExpense', input: expense });
    await first.dispatch({ type: 'approveLeave', input: leave });
    await first.dispatch({ type: 'register', input: register });
    const saved = [...f.expenses.events.pending(), ...f.leaves.events.pending(), ...f.registrations.events.pending()]; assert.equal(saved.length, 3);
    f.close(); closed = true;
    expenses = new ReplaySqliteExpenses(join(directory, 'expenses.db')); leaves = new SqliteReplayLeaves(join(directory, 'leaves.db')); registrations = new ReplayRegistrationRepository(join(directory, 'registrations.db'));
    assert.deepEqual([...expenses.events.pending(), ...leaves.events.pending(), ...registrations.events.pending()], saved);
    const app = createApplication(<Fragment><ReplayExpenses repository={expenses} actor={boss} /><ReplayLeaves repository={leaves} actor={boss} /><Registrations repository={registrations} actor={signup} /></Fragment>);
    const session = await app.start(f.screen), executed: string[] = [];
    session.subscribeExecution(event => { if (event.kind === 'queued') executed.push(event.operation); });
    for (const envelope of saved) assert((await session.deliver(envelope)).ok);
    assert.deepEqual(executed, ['expense.query.v1', 'leave.query.v1', 'registration.query.v1']);
    assert.equal(session.snapshot().view.expense?.kind, 'approved'); assert.equal(session.snapshot().view.leave?.kind, 'approved'); assert.equal(session.snapshot().view.registration?.kind, 'awaiting');
    assert.equal([...expenses.events.pending(), ...leaves.events.pending(), ...registrations.events.pending()].length, 3);
  } finally {
    if (!closed) f.close(); expenses?.close(); leaves?.close(); registrations?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
