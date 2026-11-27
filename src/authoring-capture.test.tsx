/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createApplication, Operation } from './framework/authoring.js';
import { ok, err, type Result, type ExecutionEvent, type StepObservation } from './framework/index.js';
import { Expenses, approval, type ExpenseRepository } from './experiments/react-business/expense.js';
import { BudgetExpenses, budgetApproval, type BudgetPolicyRepository } from './experiments/react-business/expense-budget.js';
import { ReplayExpenses, replayedApproval, type ReplayExpenseRepository } from './experiments/react-business/expense-replay.js';
import { ReplaySqliteExpenses } from './expenses/sqlite-replay.js';
import { expenseReplayCommands } from './expenses/replay.js';
import { draftExpense, type Change, type RuleError } from './expenses/domain.js';
const manager = { id: 'boss', role: 'manager', active: true } as const;
const input = { id: 'one', expectedVersion: 1 };
const current = { kind: 'manager', id: 'one', owner: 'owner', amount: 1000, receipt: true, version: 1 } as const;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function id(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    if ('id' in value && typeof value.id === 'string') return value.id;
    if ('input' in value && value.input !== value) return id(value.input);
  }
  return '';
}
function expenseState(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const state = 'current' in value ? value.current : 'next' in value ? value.next : value;
  return state !== null && typeof state === 'object' && 'kind' in state && typeof state.kind === 'string' ? state.kind : null;
}
function fixture() {
  const calls: string[] = [];
  const repository: ExpenseRepository = {
    async load(input, actor) { calls.push('load'); return ok({ current, input, actor }); },
    async save(change) { calls.push('save'); return ok(change); },
  };
  return { calls, repository };
}
test('selected inputs and results are captured once, after projection, without reading unselected accessors', async () => {
  const f = fixture(), source = { ...input, token: 'private-token' };
  let getterReads = 0;
  Object.defineProperty(source, 'secret', { enumerable: true, get() { getterReads++; throw new Error('Do not read'); } });
  const app = createApplication(<Expenses repository={f.repository} actor={manager} />);
  const report = await app.executeDetailed(approval, source, {
    input: (value, step) => ({ id: id(value), step, state: expenseState(value) }),
    result: result => ({ ok: result.ok, state: result.ok ? expenseState(result.value) : null }),
  });
  const exactInput: Equal<typeof report.observations[number]['input'], { id: string; step: string; state: string | null }> = true;
  const exactResult: Equal<typeof report.result, Result<Change, RuleError | 'LoadFailed' | 'SaveFailed'>> = true;
  void exactInput; void exactResult;
  assert.equal(report.result.ok, true);
  assert.equal(getterReads, 0); assert.deepEqual(report.observationErrors, []);
  assert.deepEqual(f.calls, ['load', 'save']);
  assert.deepEqual(report.observations.map(row => row.step), ['expense.approve.v1:load', 'authorize-approval', 'approve', 'expense.approve.v1']);
  assert.equal(report.observations.every(row => row.result.ok), true);
  const transition = report.observations.find(row => row.step === 'approve');
  assert.equal(transition?.input.state, 'manager');
  assert.deepEqual(transition?.result, { ok: true, state: 'approved' });
  assert.equal(JSON.stringify(report.observations).includes('private-token'), false);
  source.id = 'changed';
  assert.equal(report.observations[0]?.input.id, 'one');
  assert.equal(Object.isFrozen(report.observations), true);
  if (false) {
    // @ts-expect-error Capture must not weaken required request fields.
    void app.executeDetailed(approval, { id: 'one' }, { input: () => null, result: result => result.ok });
  }
});
test('capture failures are metadata and never stop or repeat business execution or live notification', async () => {
  const f = fixture(), events: ExecutionEvent[] = [];
  const app = createApplication(<Expenses repository={f.repository} actor={manager} />, { observeExecution: event => events.push(event) });
  const report = await app.executeDetailed(approval, input, {
    input: (_value, step) => { if (step === 'authorize-approval') throw new Error('input projection'); return step; },
    result: (result, step) => { if (step === 'approve') throw new Error('result projection'); return result.ok; },
  });
  assert.equal(report.result.ok, true); assert.deepEqual(f.calls, ['load', 'save']);
  assert.deepEqual(report.observationErrors, [
    { step: 'authorize-approval', phase: 'input', kind: 'CaptureFailed' },
    { step: 'approve', phase: 'result', kind: 'CaptureFailed' },
  ]);
  assert.deepEqual(report.observations.map(row => row.step), ['expense.approve.v1:load', 'expense.approve.v1']);
  assert.equal(events.filter(event => event.kind === 'span-completed').length, 4);
  assert.equal(events.some(event => event.kind === 'completed' && event.status === 'ok'), true);
});
test('middle IO and inner pure rules share one selected capture and live execution', async () => {
  const f = fixture(), events: ExecutionEvent[] = [];
  let reads = 0;
  const policies: BudgetPolicyRepository = { async read() { reads++; return ok({ approvalLimit: 2000 }); } };
  const app = createApplication(<BudgetExpenses repository={f.repository} policies={policies} actor={manager} />, { sessionId: 'capture', observeExecution: event => events.push(event) });
  const report = await app.executeDetailed(budgetApproval, input, { input: (value, step) => ({ id: id(value), step }), result: result => result.ok });
  assert.equal(report.result.ok, true); assert.equal(reads, 1); assert.deepEqual(f.calls, ['load', 'save']);
  assert.deepEqual(report.observations.map(row => row.step), report.trace.map(row => row.step));
  assert.equal(report.observations.some(row => row.step === 'read-budget-policy' && row.input.id === 'one' && row.result), true);
  assert.equal(report.observations.some(row => row.step === 'check-budget-policy'), true);
  assert.equal(events.every(event => event.executionId === 'capture/1'), true);
});
test('domain failure remains a domain failure when its capture fails', async () => {
  const f = fixture();
  const app = createApplication(<Expenses repository={f.repository} actor={{ ...manager, active: false }} />);
  const report = await app.executeDetailed(approval, input, { input: () => { throw new Error('capture'); }, result: () => null });
  assert.deepEqual(report.result, err({ kind: 'Forbidden' }));
  assert.deepEqual(f.calls, ['load']);
  assert.equal(report.observationErrors.length, 2);
});
test('receipt replay observes the replay boundary without fabricating domain observations', async t => {
  const stored = new ReplaySqliteExpenses(':memory:'); t.after(() => stored.close());
  const employee = { id: 'owner', role: 'employee', active: true } as const;
  const draft = draftExpense({ id: 'one', owner: employee.id, amount: 20000, receipt: true });
  assert.equal(draft.ok, true); if (!draft.ok) throw new Error('ExpectedDraft');
  assert.equal(stored.insertDraft(draft.value).ok, true);
  assert.equal((await expenseReplayCommands(stored, employee).submit.run({ requestId: 'seed', input })).ok, true);
  const calls: string[] = [];
  const repository: ReplayExpenseRepository = {
    async load(input, actor) { calls.push('load'); return stored.load(input, actor); },
    receipt(request) { calls.push('lookup'); return stored.receipt(request); },
    async saveRequest(request, change) { calls.push('save'); return stored.saveRequest(request, change); },
  };
  const app = createApplication(<ReplayExpenses repository={repository} actor={manager} />);
  const request = { requestId: 'approval', input: { id: 'one', expectedVersion: 2 } };
  const capture = { input: (_value: unknown, step: string) => step, result: (result: Result<unknown, unknown>) => result.ok };
  const first = await app.executeDetailed(replayedApproval, request, capture);
  assert.equal(first.result.ok, true);
  assert.equal(first.observations.some(row => row.step === 'authorize-approval'), true);
  assert.deepEqual(calls, ['lookup', 'load', 'save']); calls.length = 0;
  const repeated = await app.executeDetailed(replayedApproval, request, capture);
  assert.equal(repeated.result.ok && repeated.result.value.kind === 'replayed', true);
  assert.equal(repeated.attempt, null);
  assert.deepEqual(repeated.observations.map(row => row.step), ['replay.snapshot', 'replay.lookup:before']);
  assert.deepEqual(calls, ['lookup']);
});
test('selected capture replaces custom report observation metadata without intersecting incompatible types', async () => {
  let calls = 0;
  function useOpaque() {
    return { run: async (input: number) => ok(input), runDetailed: async (input: number) => {
      calls++; return { result: ok(input), trace: [], plan: null, observations: 'host-metadata', observationErrors: 7 };
    } };
  }
  const key = { name: 'opaque', use: useOpaque };
  function Opaque() { return <Operation operation={key} />; }
  const app = createApplication(<Opaque />);
  const plain = await app.executeDetailed(key, 1); assert.equal(plain.observations, 'host-metadata');
  const captured = await app.executeDetailed(key, 1, { input: () => 1, result: result => result.ok });
  const exact: Equal<typeof captured.observations, readonly StepObservation<number, boolean>[]> = true; void exact;
  assert.equal(calls, 2);
  assert.deepEqual(captured.observations, []); assert.deepEqual(captured.observationErrors, []);
});

test('accidental native async selectors produce capture errors without unhandled rejections', async t => {
  const rejected: unknown[] = [];
  const listener = (cause: unknown) => { rejected.push(cause); };
  process.on('unhandledRejection', listener); t.after(() => process.removeListener('unhandledRejection', listener));
  for (const phase of ['input', 'result'] as const) {
    const f = fixture();
    const app = createApplication(<Expenses repository={f.repository} actor={manager} />);
    const fail = async () => { throw new Error('accidental async selector'); };
    const capture = phase === 'input' ? { input: fail, result: () => null } : { input: () => null, result: fail };
    const report = await app.executeDetailed(approval, input, capture);
    assert.equal(report.result.ok, true); assert.deepEqual(f.calls, ['load', 'save']);
    assert.equal(report.observations.length, 0);
    assert.equal(report.observationErrors.length, 4);
    assert.equal(report.observationErrors.every(error => error.phase === phase), true);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(rejected, []);
});
test('concurrent selected captures own their snapshots independently', async () => {
  const f = fixture();
  const app = createApplication(<Expenses repository={f.repository} actor={manager} />);
  const [first, second] = await Promise.all([
    app.executeDetailed(approval, input, { input: () => ({ label: 'first' }), result: result => result.ok }),
    app.executeDetailed(approval, input, { input: () => ({ label: 'second' }), result: result => String(result.ok) }),
  ]);
  assert.equal(first.observations.every(row => row.input.label === 'first' && row.result === true), true);
  assert.equal(second.observations.every(row => row.input.label === 'second' && row.result === 'true'), true);
  assert.equal(first.observations.length, 4); assert.equal(second.observations.length, 4);
  assert.deepEqual(f.calls, ['load', 'load', 'save', 'save']);
});
