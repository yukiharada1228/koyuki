/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createApplication } from './experiments/react-business/runtime.js';
import { Expenses, approval, type ExpenseRepository } from './experiments/react-business/expense.js';
import { ok, type ExecutionEvent } from './framework/index.js';
const manager = { id: 'boss', role: 'manager', active: true } as const;
const input = { id: 'one', expectedVersion: 1 };
const current = { kind: 'manager', id: 'one', owner: 'owner', amount: 1000, receipt: true, version: 1 } as const;
test('JSX dispatch emits live spans while IO is still pending and retains each domain rule', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const events: ExecutionEvent[] = [], calls: string[] = [];
  const repository: ExpenseRepository = {
    async load(input, actor) { calls.push('load'); await pending; return ok({ input, actor, current }); },
    async save(change) { calls.push('save'); return ok(change); },
  };
  const app = createApplication(<Expenses repository={repository} actor={manager} />, { sessionId: 'jsx-live', observeExecution: event => events.push(event) });
  assert.equal(events.length, 0);
  const running = app.dispatch(approval, input);
  assert.deepEqual(calls, ['load']);
  assert.equal(events.some(event => event.kind === 'span-started' && event.step === 'expense.approve.v1:load'), true);
  assert.equal(events.some(event => event.kind === 'completed'), false);
  release(); assert.equal((await running).ok, true);
  assert.deepEqual(calls, ['load', 'save']);
  assert.deepEqual(events.filter(event => event.kind === 'span-started').map(event => event.step), ['expense.approve.v1:load', 'authorize-approval', 'approve', 'expense.approve.v1']);
  assert.equal(events.every(event => event.executionId === 'jsx-live/1'), true);
  assert.equal(events.some(event => event.kind === 'completed' && event.status === 'ok'), true);
  const started = events.filter(event => event.kind === 'span-started').map(event => event.spanId);
  const completed = events.filter(event => event.kind === 'span-completed').map(event => event.spanId);
  assert.deepEqual(completed, started);
});
test('concurrent calls on one JSX application have distinct execution IDs', async () => {
  const events: ExecutionEvent[] = [];
  const repository: ExpenseRepository = {
    async load(input, actor) { await Promise.resolve(); return ok({ input, actor, current }); },
    async save(change) { return ok(change); },
  };
  const app = createApplication(<Expenses repository={repository} actor={manager} />, { sessionId: 'parallel' });
  const stop = app.subscribeExecution(event => events.push(event));
  await Promise.all([app.dispatch(approval, input), app.inspect(approval, input)]);
  assert.deepEqual([...new Set(events.map(event => event.executionId))].sort(), ['parallel/1', 'parallel/2']);
  for (const id of ['parallel/1', 'parallel/2']) {
    const own = events.filter(event => event.executionId === id);
    assert.equal(own.filter(event => event.kind === 'completed').length, 1);
    assert.equal(own.filter(event => event.kind === 'span-started').length, 4);
    assert.equal(own.filter(event => event.kind === 'span-completed').length, 4);
  }
  stop(); const size = events.length;
  await app.dispatch(approval, input);
  assert.equal(events.length, size);
});
test('unexpected IO exceptions close the live span as a defect without becoming domain failures', async () => {
  const cause = new Error('load rejected'), events: ExecutionEvent[] = [];
  let saves = 0;
  const repository: ExpenseRepository = {
    async load() { throw cause; },
    async save(change) { saves++; return ok(change); },
  };
  const app = createApplication(<Expenses repository={repository} actor={manager} />, { observeExecution: event => events.push(event) });
  await assert.rejects(app.dispatch(approval, input), error => error === cause);
  assert.equal(saves, 0);
  assert.equal(events.some(event => event.kind === 'span-completed' && event.step === 'expense.approve.v1:load' && event.status === 'defect'), true);
  assert.equal(events.some(event => event.kind === 'completed' && event.status === 'defect'), true);
});
test('throwing or rejecting diagnostic observers cannot change the business outcome', async () => {
  let saves = 0;
  const repository: ExpenseRepository = {
    async load(input, actor) { return ok({ input, actor, current }); },
    async save(change) { saves++; return ok(change); },
  };
  const app = createApplication(<Expenses repository={repository} actor={manager} />, { observeExecution() { throw new Error('diagnostic'); } });
  app.subscribeExecution(async () => { throw new Error('rejected diagnostic'); });
  assert.equal((await app.dispatch(approval, input)).ok, true);
  assert.equal(saves, 1);
});
