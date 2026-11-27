/** @jsx h */
import { h, Fragment, createApplication } from '../../framework/authoring.js';
import { ReplayExpenses } from './expense-replay.js';
import { ReplayLeaves } from './leave-replay.js';
import { Registrations } from './registration.js';
import { businessDashboard } from './dashboard.js';
import { SqliteReplayLeaves } from './leave-sqlite.js';
import { ReplaySqliteExpenses } from '../../expenses/sqlite-replay.js';
import { ReplayRegistrationRepository } from '../../registration/replay-repository.js';
import { draftExpense } from '../../expenses/domain.js';
import { expenseReplayCommands } from '../../expenses/replay.js';
const manager = { id: 'boss', role: 'manager', active: true } as const;
const employee = { id: 'employee', role: 'employee', active: true } as const;
const expenses = new ReplaySqliteExpenses(':memory:'), leaves = new SqliteReplayLeaves(':memory:'), registrations = new ReplayRegistrationRepository(':memory:');
try {
  // Demo fixtures, before mounting. These adapters send no actual mail.
  const draft = draftExpense({ id: 'expense', owner: employee.id, amount: 20000, receipt: true });
  if (!draft.ok || !expenses.insertDraft(draft.value).ok) throw new Error('InvalidDemoFixture');
  await expenseReplayCommands(expenses, employee).submit.run({ requestId: 'seed', input: { id: 'expense', expectedVersion: 1 } });
  leaves.seed({ kind: 'pending', id: 'holiday', owner: employee.id, days: 3 });
  const app = createApplication(<Fragment>
    <ReplayExpenses repository={expenses} actor={manager} />
    <ReplayLeaves repository={leaves} actor={manager} />
    <Registrations repository={registrations} actor={employee} />
  </Fragment>);
  const registration = { requestId: 'register-one', id: 'person', email: 'person@example.test' };
  const session = await app.start(businessDashboard({ expenseId: 'expense', leaveId: 'holiday', registrationRequest: registration }));
  const unsubscribe = session.subscribe(({ view }) => console.log({ expense: view.expense?.kind, leave: view.leave?.kind, registration: view.registration?.kind ?? null, busy: view.busy, error: view.error, queries: view.queries }));
  await session.dispatch({ type: 'approveExpense', input: { requestId: 'approve-one', input: { id: 'expense', expectedVersion: 2 } } });
  await session.dispatch({ type: 'approveLeave', input: { requestId: 'approve-holiday', input: { id: 'holiday' } } });
  await session.dispatch({ type: 'register', input: registration });
  // Simulate the user following a confirmation link received in the demo outbox.
  const email = await registrations.claim(0, 100);
  if (!email.ok) throw new Error('ExpectedDemoEmail');
  await session.dispatch({ type: 'confirmRegistration', input: { requestId: 'confirm-one', id: 'person', token: email.value.event.token, now: 20 } });
  await session.dispatch({ type: 'register', input: registration }); // Cached awaiting result must not regress the confirmed view.
  unsubscribe();
  console.log('final', { expense: session.snapshot().view.expense?.kind, leave: session.snapshot().view.leave?.kind, registration: session.snapshot().view.registration?.kind });
} finally { expenses.close(); leaves.close(); registrations.close(); }
