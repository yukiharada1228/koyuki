// Maintainer reference. Do not distribute as the participant's application.ts.
import { business, ok, err, type Result } from 'koyuki';
import type { Ports, Loaded, VersionInput, SubmitInput, RejectInput, Submitted, Approved, Rejected, RuleError } from './contracts.js';
function guard<I extends VersionInput>({ input, current, actor }: Loaded<I>): RuleError | null {
  if (!actor.active) return { kind: 'Denied' };
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) return { kind: 'InvalidInput' };
  return input.expectedVersion === current.version ? null : { kind: 'Conflict' };
}
function submit(value: Loaded<SubmitInput>): Result<Submitted, RuleError> {
  const failure = guard(value); if (failure) return err(failure);
  const { input, current, actor } = value;
  if (current.state !== 'draft') return err({ kind: 'WrongState' });
  if (actor.id !== current.ownerId) return err({ kind: 'Denied' });
  if (!Number.isSafeInteger(current.amountCents) || current.amountCents <= 0 || !input.approverId || input.approverId !== input.approverId.trim() || input.approverId === current.ownerId) return err({ kind: 'InvalidInput' });
  return ok({ ...current, state: 'submitted', approverId: input.approverId, submittedBy: actor.id, version: current.version + 1 });
}
function approve(value: Loaded<VersionInput>): Result<Approved, RuleError> {
  const failure = guard(value); if (failure) return err(failure);
  const { current, actor } = value;
  if (current.state !== 'submitted') return err({ kind: 'WrongState' });
  if (actor.role !== 'manager' || actor.id !== current.approverId || actor.id === current.ownerId) return err({ kind: 'Denied' });
  return ok({ ...current, state: 'approved', approvedBy: actor.id, version: current.version + 1 });
}
function reject(value: Loaded<RejectInput>): Result<Rejected, RuleError> {
  const failure = guard(value); if (failure) return err(failure);
  const { input, current, actor } = value;
  if (current.state !== 'submitted') return err({ kind: 'WrongState' });
  if (actor.role !== 'manager' || actor.id !== current.approverId || actor.id === current.ownerId) return err({ kind: 'Denied' });
  const reason = input.reason.trim(); if (!reason || reason.length > 500) return err({ kind: 'InvalidInput' });
  return ok({ ...current, state: 'rejected', rejectedBy: actor.id, reason, version: current.version + 1 });
}
export function createExpenses(ports: Ports) {
  return business({ name: 'onboarding.expense', load: ports.load<SubmitInput>, save: ports.save, operations: {
    submit: [submit], approve: { load: ports.load<VersionInput>, run: [approve] }, reject: { load: ports.load<RejectInput>, run: [reject] },
  } });
}
