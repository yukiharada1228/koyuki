/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createApplication } from './experiments/react-business/runtime.js';
import { Leaves, leaveApproval, leaveDecision, type LeaveRepository, type LeaveState } from './experiments/react-business/leave.js';
import { ok, err } from './framework/index.js';
const manager = { id: 'boss', role: 'manager', active: true } as const;
test('leave approval uses the same components and Hooks and preserves individual rule traces', async () => {
  let state: LeaveState = { kind: 'pending', id: 'holiday', owner: 'employee', days: 3 };
  const calls: string[] = [];
  const repository: LeaveRepository = {
    async load(input, actor) { calls.push(`load:${actor.id}`); return input.id === state.id ? ok({ current: state, actor }) : err('NotFound'); },
    async save(next) { calls.push('save'); if (state.kind !== 'pending') return err('SaveConflict'); state = next; return ok(next); },
  };
  const app = createApplication(<Leaves repository={repository} actor={manager} />);
  assert.deepEqual(calls, []);
  const report = await app.executeDetailed(leaveApproval, { id: 'holiday' });
  assert.deepEqual(report.result, ok({ kind: 'approved', id: 'holiday', owner: 'employee', days: 3, by: 'boss' }));
  assert.deepEqual(report.trace.map(row => row.step), ['leave.approve.v1:load', 'authorize-leave', 'approve-leave', 'leave.approve.v1']);
  assert.deepEqual(calls, ['load:boss', 'save']);
  calls.length = 0;
  const refusal = await app.executeDetailed(leaveApproval, { id: 'holiday' });
  assert.deepEqual(refusal.result, err('AlreadyDecided'));
  assert.deepEqual(refusal.trace.at(-1), { step: 'authorize-leave', status: 'error' });
  assert.deepEqual(calls, ['load:boss']);
  if (false) {
    // @ts-expect-error The same input contract survives the leave component tree.
    void app.execute(leaveApproval, { requestId: 'wrong' });
  }
});
test('leave rules also run without Hooks or persistence', () => {
  assert.deepEqual(leaveDecision.run({ current: { kind: 'pending', id: 'holiday', owner: manager.id, days: 1 }, actor: manager }), err('SelfApproval'));
});
