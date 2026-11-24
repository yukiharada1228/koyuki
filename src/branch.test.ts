import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, workflow, type Result } from './framework/index.js';
import { expenseWorkflow, createExpenseAction, type Expense, type ExpenseDecision } from './examples/expense.js';
const expense = (amount: number, receipt = true): Expense => ({ id: 'e1', amount, receipt, employeeActive: true });
for (const [amount, route] of [[3000, 'automatic'], [3001, 'manager'], [100000, 'manager'], [100001, 'manager-and-finance']] as const) {
  test(`expense boundary ${amount}: ${route}`, () => {
    const result = expenseWorkflow.run(expense(amount));
    assert.equal(result.ok && result.value.route, route);
  });
}
test('small expenses do not evaluate receipt or high amount branches', () => {
  const result = expenseWorkflow.inspect(expense(3000, false));
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.trace.map(t => t.step), ['validate-expense', 'amount-at-most-3000:yes', 'automatic']);
});
test('missing receipt stops before choosing approval requirements', () => {
  const result = expenseWorkflow.inspect(expense(3001, false));
  assert.deepEqual(result.result, err({ kind: 'ReceiptRequired' }));
  assert.equal(result.trace.at(-1)?.step, 'require-receipt');
});
test('invalid inputs never reach a branch', () => {
  for (const value of [expense(0), expense(-1), expense(1.5), expense(NaN), { ...expense(100), employeeActive: false }]) {
    const result = expenseWorkflow.inspect(value);
    assert.equal(result.result.ok, false);
    assert.equal(result.trace.length, 1);
  }
});
test('action persists only the selected decision once and propagates conflicts', async () => {
  let saves = 0;
  const action = createExpenseAction({ load: async () => ok(expense(200000)), save: async decision => {
    saves++; assert.equal(decision.route, 'manager-and-finance'); return err({ kind: 'SaveConflict' });
  } });
  const result = await action.runDetailed('e1');
  assert.deepEqual(result.result, err({ kind: 'SaveConflict' }));
  assert.equal(saves, 1);
  assert.equal(result.trace[0]?.step, 'load-expense');
  assert.deepEqual(result.trace.at(-1), { step: 'expense.submit.v1', status: 'error' });
});
test('domain rejection causes no save', async () => {
  const action = createExpenseAction({ load: async () => ok(expense(5000, false)), save: async () => { throw new Error('must not save'); } });
  assert.deepEqual(await action.run('e1'), err({ kind: 'ReceiptRequired' }));
});
test('branch preserves different output and error types and evaluates one path', () => {
  let rejected = 0;
  const branch = workflow('start', (n: number) => ok(n)).branch('positive', n => n > 0, {
    yes: workflow('positive-value', (n: number): Result<string, 'positive-error'> => ok(String(n))),
    no: workflow('negative-value', (_n: number): Result<boolean, 'negative-error'> => { rejected++; return err('negative-error'); }),
  });
  const typed: Result<string | boolean, 'positive-error' | 'negative-error'> = branch.run(1);
  assert.deepEqual(typed, ok('1')); assert.equal(rejected, 0);
  assert.deepEqual(branch.run(-1), err('negative-error')); assert.equal(rejected, 1);
  // @ts-expect-error both output types must be handled
  const narrowed: Result<string, 'positive-error' | 'negative-error'> = branch.run(1);
  void narrowed;
});
