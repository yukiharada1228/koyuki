import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, workflow, type Result } from './framework/index.js';
import { authorizeLeave, approveLeave, type AuthorizedLeave, type PendingLeave, type ApprovedLeave, type LeaveState, type LeaveError, type LeaveApprover } from './experiments/react-business/leave-domain.js';
import type { Actor } from './expenses/domain.js';
const manager: Actor = { id: 'boss', role: 'manager', active: true };
const pending: PendingLeave = { kind: 'pending', id: 'holiday', owner: 'owner', days: 3 };
const decision = workflow('authorize-leave', authorizeLeave).then('approve-leave', approveLeave);
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
test('only successful authorization supplies the prerequisite for the pure transition', () => {
  const authorized = authorizeLeave({ current: pending, actor: manager });
  const exact: Equal<typeof authorized, Result<AuthorizedLeave, 'AlreadyDecided' | 'Forbidden' | 'SelfApproval'>> = true; void exact;
  assert.equal(authorized.ok, true); if (!authorized.ok) throw new Error('ExpectedAuthorizedLeave');
  const result = approveLeave(authorized.value);
  assert.deepEqual(result, ok({ kind: 'approved', id: 'holiday', owner: 'owner', days: 3, by: 'boss' }));
  assert.deepEqual(pending, { kind: 'pending', id: 'holiday', owner: 'owner', days: 3 });
  assert.equal(Object.isFrozen(authorized.value), true);
  assert.equal(Object.isFrozen(authorized.value.current), true);
  assert.equal(Object.isFrozen(authorized.value.actor), true);
  if (false) {
    const eligibleActor: LeaveApprover = { id: 'boss', role: 'manager', active: true };
    // @ts-expect-error Pending state alone is not proof of authority.
    approveLeave({ current: pending, actor: eligibleActor });
    const context = { current: pending, actor: eligibleActor };
    // @ts-expect-error A specialized pending loader cannot remove authorization.
    workflow('skip-authorization', (value: typeof context) => ok(value)).then('approve', approveLeave);
    // @ts-expect-error The successful authorization type retains the manager/active facts.
    approveLeave({ ...authorized.value, actor: { ...manager, role: 'employee' } });
    // @ts-expect-error The successful authorization type retains active:true.
    approveLeave({ ...authorized.value, actor: { ...manager, role: 'manager', active: false } });
    const pretendedAuthorization = { ...context, authorized: true };
    // @ts-expect-error A plain boolean cannot supply the private authorization symbol.
    approveLeave(pretendedAuthorization);
  }
});
test('state and authorization failures preserve their priority and stop before approval', () => {
  const approved: ApprovedLeave = { kind: 'approved', id: 'holiday', owner: 'owner', days: 3, by: 'boss' };
  const cases: readonly [LeaveState, Actor, LeaveError][] = [
    [approved, { id: 'owner', role: 'employee', active: false }, 'AlreadyDecided'],
    [pending, { id: 'owner', role: 'employee', active: false }, 'SelfApproval'],
    [pending, { id: 'owner', role: 'manager', active: true }, 'SelfApproval'],
    [pending, { ...manager, active: false }, 'Forbidden'],
    [pending, { ...manager, role: 'employee' }, 'Forbidden'],
    [pending, { ...manager, role: 'finance' }, 'Forbidden'],
  ];
  for (const [current, actor, expected] of cases) {
    const report = decision.inspect({ current, actor });
    assert.deepEqual(report.result, err(expected));
    assert.deepEqual(report.trace, [{ step: 'authorize-leave', status: 'error' }]);
  }
});
test('authorized context is detached from mutable caller-owned state and actor claims', () => {
  const source = { kind: 'pending' as const, id: 'holiday', owner: 'owner', days: 3 }, actor = { ...manager };
  const result = authorizeLeave({ current: source, actor });
  assert.equal(result.ok, true); if (!result.ok) throw new Error('ExpectedAuthorizedLeave');
  source.owner = 'changed'; source.days = 99; actor.id = 'changed'; actor.active = false;
  assert.deepEqual(approveLeave(result.value), ok({ kind: 'approved', id: 'holiday', owner: 'owner', days: 3, by: 'boss' }));
});
