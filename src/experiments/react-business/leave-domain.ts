import { ok, err, type Result } from '../../framework/index.js';
import type { Actor } from '../../expenses/domain.js';
export type PendingLeave = Readonly<{ kind: 'pending'; id: string; owner: string; days: number }>;
export type ApprovedLeave = Readonly<{ kind: 'approved'; id: string; owner: string; days: number; by: string }>;
export type LeaveState = PendingLeave | ApprovedLeave;
export type LeaveInput = Readonly<{ id: string }>;
export type LeaveContext = Readonly<{ current: LeaveState; actor: Actor }>;
export type LeaveError = 'AlreadyDecided' | 'Forbidden' | 'SelfApproval';
const authorization: unique symbol = Symbol('AuthorizedLeave');
export type LeaveApprover = Readonly<{ id: string; role: 'manager'; active: true }>;
export type AuthorizedLeave = Readonly<{ current: PendingLeave; actor: LeaveApprover; [authorization]: true }>;
export function authorizeLeave({ current, actor }: LeaveContext): Result<AuthorizedLeave, LeaveError> {
  if (current.kind !== 'pending') return err('AlreadyDecided');
  if (actor.id === current.owner) return err('SelfApproval');
  if (!actor.active || actor.role !== 'manager') return err('Forbidden');
  const state = Object.freeze({ kind: current.kind, id: current.id, owner: current.owner, days: current.days });
  const approver = Object.freeze({ id: actor.id, role: actor.role, active: actor.active });
  return ok(Object.freeze({ current: state, actor: approver, [authorization]: true }));
}
export function approveLeave({ current, actor }: AuthorizedLeave): Result<ApprovedLeave, never> {
  return ok(Object.freeze({ ...current, kind: 'approved', by: actor.id }));
}
