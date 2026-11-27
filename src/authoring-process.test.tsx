/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createApplication, createContext, useContext, useOperation, operationKey, Operation } from './framework/authoring.js';
import { process, workflow, ok, err, type Result, type Execution, type Receipt, type ReplayInputError, type ExecutionEvent } from './framework/index.js';
import { BudgetExpenses, budgetApproval, approveWithBudgetPolicy, type BudgetPolicyRepository } from './experiments/react-business/expense-budget.js';
import type { ExpenseRepository } from './experiments/react-business/expense.js';
import { validateApproval, type Change, type RuleError } from './expenses/domain.js';
const manager = { id: 'boss', role: 'manager', active: true } as const;
const current = { kind: 'manager', id: 'one', owner: 'owner', amount: 1000, receipt: true, version: 1 } as const;
const input = { id: 'one', expectedVersion: 1 };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function fixture(failure?: 'load' | 'policy', limit = 2000, wait?: () => Promise<void>) {
  const calls: string[] = [];
  const repository: ExpenseRepository = {
    async load(input, actor) { calls.push(`load:${actor.id}`); return failure === 'load' ? err('LoadFailed') : ok({ input, actor, current }); },
    async save(change) { calls.push('save'); return ok(change); },
  };
  const policies: BudgetPolicyRepository = {
    async read(context) { calls.push(`policy:${context.actor.id}`); await wait?.(); return failure === 'policy' ? err('BudgetUnavailable') : ok({ approvalLimit: limit }); },
  };
  return { calls, repository, policies };
}
test('Hooks compose an explicit middle IO read with pure rules, exact errors and live inner spans', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(undefined, 2000, async () => { entered(); await pending; });
  const events: ExecutionEvent[] = [];
  const app = createApplication(<BudgetExpenses {...f} actor={manager} />, { observeExecution: event => events.push(event) });
  assert.deepEqual(f.calls, []);
  const output = app.dispatch(budgetApproval, input);
  const exact: Equal<typeof output, Promise<Result<Change, RuleError | 'LoadFailed' | 'SaveFailed' | 'BudgetUnavailable' | 'ApprovalLimitExceeded'>>> = true; void exact;
  await reading;
  assert.deepEqual(f.calls, ['load:boss', 'policy:boss']);
  assert.equal(events.some(event => event.kind === 'span-started' && event.step === 'read-budget-policy'), true);
  assert.equal(events.some(event => event.kind === 'completed'), false);
  const readSpan = events.find(event => event.kind === 'span-started' && event.step === 'read-budget-policy');
  const executeSpan = events.find(event => event.kind === 'span-started' && event.step === 'expense.approve-with-budget.v1:execute');
  assert.equal(readSpan?.kind === 'span-started' && executeSpan?.kind === 'span-started' && readSpan.parentSpanId === executeSpan.spanId, true);
  release(); assert.equal((await output).ok, true);
  assert.deepEqual(f.calls, ['load:boss', 'policy:boss', 'save']);
  const report = await app.inspect(budgetApproval, input);
  assert.deepEqual(report.trace.map(row => row.step), ['expense.approve-with-budget.v1:load', 'authorize-approval', 'read-budget-policy', 'check-budget-policy', 'approve', 'expense.approve-with-budget.v1:execute', 'expense.approve-with-budget.v1']);
});
test('load, authorization, policy IO and pure policy failure each stop the remaining stages', async () => {
  for (const stage of ['load', 'authorize', 'policy', 'limit'] as const) {
    const f = fixture(stage === 'load' || stage === 'policy' ? stage : undefined, stage === 'limit' ? 10 : 2000);
    const actor = stage === 'authorize' ? { ...manager, active: false } : manager;
    const app = createApplication(<BudgetExpenses {...f} actor={actor} />);
    const report = await app.inspect(budgetApproval, input);
    const expected = stage === 'load' ? err('LoadFailed') : stage === 'authorize' ? err({ kind: 'Forbidden' }) : stage === 'policy' ? err('BudgetUnavailable') : err('ApprovalLimitExceeded');
    assert.deepEqual(report.result, expected);
    assert.deepEqual(f.calls, stage === 'load' || stage === 'authorize' ? ['load:boss'] : ['load:boss', 'policy:boss']);
    const name = stage === 'load' ? 'expense.approve-with-budget.v1:load' : stage === 'authorize' ? 'authorize-approval' : stage === 'policy' ? 'read-budget-policy' : 'check-budget-policy';
    assert.equal(report.trace.some(row => row.step === name && row.status === 'error'), true);
  }
});
test('a detailed Process may also prepare the initial load without losing its internal stages', async () => {
  const calls: string[] = [];
  function useCalculation() {
    return useOperation({ name: 'calculation',
      load: process<number>().effect('read-input', async input => { calls.push('read'); return ok(input + 1); }),
      execute: workflow('double', (input: number) => ok(input * 2)),
      save: async (output: number) => { calls.push('save'); return ok(output); },
    });
  }
  const calculation = operationKey('calculation', useCalculation);
  function Calculation() { const handler = useCalculation(); return <Operation operation={calculation} handler={handler} />; }
  const app = createApplication(<Calculation />);
  const report = await app.inspect(calculation, 3);
  assert.deepEqual(report.result, ok(8));
  assert.deepEqual(calls, ['read', 'save']);
  assert.deepEqual(report.trace.map(row => row.step), ['read-input', 'calculation:load', 'double', 'calculation']);
});
test('Process execution retains request-scoped dependencies and skips middle IO on receipt replay', async () => {
  const Identity = createContext<string>();
  const calls: string[] = [];
  const receipts = new Map<string, string>();
  function useCalculation() {
    const actor = useContext(Identity);
    return useOperation({ name: 'replay-process',
      load: async (input: number): Promise<Result<number, 'LoadFailed'>> => { calls.push(`load:${actor}`); return ok(input); },
      execute: process<number>().effect('read-policy', async input => { calls.push(`policy:${actor}`); await Promise.resolve(); return ok(`${actor}:${input}`); }),
      save: async (output: string, input: number): Promise<Result<Execution<string>, 'SaveFailed'>> => { calls.push(`save:${actor}`); receipts.set(`${actor}:${input}`, output); return ok({ kind: 'committed', value: output }); },
      replay: { lookup: (input: number): Result<Receipt<string>, 'LookupFailed'> => { const receipt = receipts.get(`${actor}:${input}`); return ok(receipt === undefined ? { kind: 'missing' } : { kind: 'found', value: receipt }); }, resolveAfter: () => false },
    });
  }
  const key = operationKey('replay-process', useCalculation);
  function Calculation() { const handler = useCalculation(); return <Operation operation={key} handler={handler} />; }
  const first = createApplication(<Identity.Provider value="first"><Calculation /></Identity.Provider>);
  const second = createApplication(<Identity.Provider value="second"><Calculation /></Identity.Provider>);
  const running = await Promise.all([first.dispatch(key, 1), second.dispatch(key, 2)]);
  const exact: Equal<typeof running[number], Result<Execution<string>, 'LoadFailed' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>> = true; void exact;
  assert.deepEqual(running, [ok({ kind: 'committed', value: 'first:1' }), ok({ kind: 'committed', value: 'second:2' })]);
  assert.equal(calls.includes('policy:first') && calls.includes('policy:second'), true);
  const before = [...calls];
  const replay = await second.inspect(key, 2);
  assert.deepEqual(replay.result, ok({ kind: 'replayed', value: 'second:2' }));
  assert.equal(replay.attempt, null); assert.deepEqual(calls, before);
});

test('unexpected middle IO rejection propagates its original cause and closes both nested spans', async () => {
  const f = fixture(), cause = new Error('policy read rejected'), events: ExecutionEvent[] = [];
  const policies: BudgetPolicyRepository = { async read() { throw cause; } };
  const app = createApplication(<BudgetExpenses repository={f.repository} policies={policies} actor={manager} />, { observeExecution: event => events.push(event) });
  await assert.rejects(app.dispatch(budgetApproval, input), error => error === cause);
  assert.deepEqual(f.calls, ['load:boss']);
  for (const step of ['read-budget-policy', 'expense.approve-with-budget.v1:execute']) {
    assert.equal(events.some(event => event.kind === 'span-completed' && event.step === step && event.status === 'defect'), true);
  }
  assert.equal(events.some(event => event.kind === 'completed' && event.status === 'defect'), true);
});

test('budget policy and state transition remain a pure calculation usable without Hooks', () => {
  const authorized = validateApproval({ current, input, actor: manager });
  assert.equal(authorized.ok, true); if (!authorized.ok) throw new Error('ExpectedAuthorizedApproval');
  const approved = approveWithBudgetPolicy.run({ ...authorized.value, budget: { approvalLimit: 2000 } });
  assert.deepEqual(approved, ok({ expectedVersion: 1, next: { id: 'one', owner: 'owner', amount: 1000, receipt: true, version: 2, kind: 'approved', approval: { kind: 'manager', manager: 'boss' } } }));
  assert.deepEqual(approveWithBudgetPolicy.run({ ...authorized.value, budget: { approvalLimit: 10 } }), err('ApprovalLimitExceeded'));
});
