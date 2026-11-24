import { draftExpense, type Actor } from './domain.js';
import { MemoryExpenses } from './repository.js';
import { expenseApplication } from './application.js';
const draft = draftExpense({ id: 'expense-1', owner: 'employee-1', amount: 200000, receipt: true });
if (!draft.ok) throw new Error('InvalidFixture');
const repository = new MemoryExpenses([draft.value]);
const steps = [
  { actor: { id: 'employee-1', role: 'employee', active: true } satisfies Actor, event: 'submit' as const },
  { actor: { id: 'manager-1', role: 'manager', active: true } satisfies Actor, event: 'approve' as const },
  { actor: { id: 'finance-1', role: 'finance', active: true } satisfies Actor, event: 'approve' as const },
];
for (const step of steps) {
  // Host supplies the actor; each human action loads the latest persisted business state.
  const session = await expenseApplication(repository, step.actor, repository.list()).start();
  const stop = session.subscribe(({ state }) => console.log(JSON.stringify({ actor: step.actor.role, execution: state.kind, expense: state.data[0] })));
  const current = repository.read('expense-1')!;
  const result = await session.dispatch({ type: step.event, input: { id: current.id, expectedVersion: current.version } });
  if (!result.ok) throw new Error('UnexpectedDispatchFailure');
  stop();
}
console.log(JSON.stringify({ stored: repository.list(), io: repository.calls }, null, 2));
