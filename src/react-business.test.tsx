/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result } from './framework/index.js';
import { h, createApplication, createContext, useContext, useOperation, Operation } from './experiments/react-business/runtime.js';
import { Expenses, ApproveExpense, ActorContext, ExpenseRepositoryContext, approval, approveExpense, type ExpenseRepository } from './experiments/react-business/expense.js';
import type { Actor, Input, Loaded, Change, RuleError } from './expenses/domain.js';
const manager: Actor = { id: 'boss', active: true, role: 'manager' };
const employee: Actor = { id: 'owner', active: true, role: 'employee' };
const input: Input = { id: 'expense-1', expectedVersion: 1 };
const current = { kind: 'manager', id: input.id, owner: 'owner', amount: 1000, receipt: true, version: 1 } as const;
function fixture(fail?: 'load' | 'save', wait?: () => Promise<void>) {
  const calls: string[] = [];
  const repository: ExpenseRepository = {
    async load(request, actor) {
      calls.push(`load:${actor.id}`);
      await wait?.();
      return fail === 'load' ? err('LoadFailed') : ok({ input: request, actor, current });
    },
    async save(change) { calls.push('save'); return fail === 'save' ? err('SaveFailed') : ok(change); },
  };
  return { calls, repository };
}
test('components assemble without IO; explicit dispatch runs the existing command engine', async () => {
  const { repository, calls } = fixture();
  const app = createApplication(<Expenses repository={repository} actor={manager} />);
  assert.deepEqual(calls, []);
  const result = await app.dispatch(approval, input);
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  const exact: Equal<typeof result, Result<Change, RuleError | 'LoadFailed' | 'SaveFailed'>> = true;
  void exact;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.next.kind, 'approved');
  assert.deepEqual(calls, ['load:boss', 'save']);
  const report = await app.inspect(approval, input);
  assert.deepEqual(report.result, result);
  assert.equal(report.trace.length >= 3, true);
  assert.equal(report.trace.every(row => row.status === 'ok'), true);
  if (false) {
    // @ts-expect-error The operation retains required request fields through JSX.
    void app.dispatch(approval, { id: 'one' });
    // @ts-expect-error The pure approval function requires an authorized state.
    approveExpense.run({ actor: manager });
  }
});
test('pure domain composition runs outside components and exposes individual rule traces', () => {
  const value: Loaded = { input, actor: manager, current };
  const result = approveExpense.run(value);
  assert.equal(result.ok, true);
  assert.deepEqual(approveExpense.inspect(value).trace.map(row => row.step), ['authorize-approval', 'approve']);
  assert.deepEqual(approveExpense.run({ ...value, actor: employee }), err({ kind: 'SelfApproval' }));
});
test('load, domain and save failures retain Result semantics and stop subsequent effects', async () => {
  for (const fail of ['load', 'domain', 'save'] as const) {
    const { repository, calls } = fixture(fail === 'domain' ? undefined : fail);
    const actor = fail === 'domain' ? employee : manager;
    const app = createApplication(<Expenses repository={repository} actor={actor} />);
    const result = await app.dispatch(approval, input);
    assert.deepEqual(result, fail === 'domain' ? err({ kind: 'SelfApproval' }) : err(fail === 'load' ? 'LoadFailed' : 'SaveFailed'));
    assert.deepEqual(calls, fail === 'save' ? ['load:boss', 'save'] : [`load:${actor.id}`]);
  }
});
test('overlapping dispatches retain the actor captured by their request-scoped Providers', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const a = fixture(undefined, () => pending), b = fixture();
  const first = createApplication(<Expenses repository={a.repository} actor={manager} />);
  const running = first.dispatch(approval, input);
  const second = createApplication(<Expenses repository={b.repository} actor={employee} />);
  assert.deepEqual(await second.dispatch(approval, input), err({ kind: 'SelfApproval' }));
  release();
  assert.equal((await running).ok, true);
  assert.deepEqual(a.calls, ['load:boss', 'save']);
  assert.deepEqual(b.calls, ['load:owner']);
});
test('nested Providers shadow locally and restore their parent for siblings', () => {
  const Context = createContext<string>();
  const seen: string[] = [];
  function Read() { seen.push(useContext(Context)); return { evaluate() {} }; }
  function Tree() { return <Context.Provider value="outer"><Context.Provider value="inner"><Read /></Context.Provider><Read /></Context.Provider>; }
  createApplication(<Tree />);
  assert.deepEqual(seen, ['inner', 'outer']);
  assert.throws(() => useContext(Context), /HooksRequireComponentEvaluation/);
});
test('missing dependencies, failed evaluation and duplicate registrations fail during assembly', () => {
  const { repository, calls } = fixture();
  assert.throws(() => createApplication(<ApproveExpense />), /MissingContextProvider/);
  assert.throws(() => useContext(ActorContext), /HooksRequireComponentEvaluation/);
  assert.throws(() => createApplication(<ExpenseRepositoryContext.Provider value={repository}><ActorContext.Provider value={manager}><ApproveExpense /><ApproveExpense /></ActorContext.Provider></ExpenseRepositoryContext.Provider>), /DuplicateOperation/);
  assert.deepEqual(calls, []);
  const empty = createApplication({ evaluate() {} });
  assert.throws(() => empty.dispatch(approval, input), /UnregisteredOperation/);
});
// The hook must reject incompatible domain and IO contracts before execution.
function InvalidComposition() {
  if (false) {
    useOperation({ name: 'invalid', load: async (_: Input) => ok('wrong'),
      // @ts-expect-error A string load result cannot enter expense approval.
      execute: approveExpense.run, save: async (change: Change) => ok(change) });
  }
  return <ApproveExpense />;
}
void InvalidComposition;
