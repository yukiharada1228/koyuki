import { business, ok, err, type Result } from 'koyuki';
import type { Ports, Loaded, VersionInput, SubmitInput, RejectInput, Draft, Submitted, Approved, Rejected, RuleError } from './contracts.js';

type Ready<I, S> = Omit<Loaded<I>, 'current'> & Readonly<{ current: S }>;
function common<T extends Loaded<VersionInput>>(context: T): Result<T, RuleError> {
  if (!context.actor.active) return err({ kind: 'Denied' });
  if (!Number.isSafeInteger(context.input.expectedVersion) || context.input.expectedVersion < 1) return err({ kind: 'InvalidInput' });
  if (context.input.expectedVersion !== context.current.version) return err({ kind: 'Conflict' });
  return ok(context);
}
function submission(context: Loaded<SubmitInput>): Result<Ready<SubmitInput, Draft>, RuleError> {
  const { current, actor, input } = context;
  if (current.state !== 'draft') return err({ kind: 'WrongState' });
  if (actor.id !== current.ownerId) return err({ kind: 'Denied' });
  if (!Number.isSafeInteger(current.amountCents) || current.amountCents <= 0 || !input.approverId || input.approverId.trim() !== input.approverId || input.approverId === current.ownerId) return err({ kind: 'InvalidInput' });
  return ok({ ...context, current });
}
function approval<I extends VersionInput>(context: Loaded<I>): Result<Ready<I, Submitted>, RuleError> {
  const { current, actor } = context;
  if (current.state !== 'submitted') return err({ kind: 'WrongState' });
  if (actor.role !== 'manager' || actor.id !== current.approverId || actor.id === current.ownerId) return err({ kind: 'Denied' });
  return ok({ ...context, current });
}
function rejection(context: Ready<RejectInput, Submitted>): Result<Ready<RejectInput, Submitted>, RuleError> {
  const reason = context.input.reason.trim();
  if (!reason || reason.length > 500) return err({ kind: 'InvalidInput' });
  return ok(context);
}
function submit({ current, actor, input }: Ready<SubmitInput, Draft>): Result<Submitted, never> {
  return ok({ ...current, state: 'submitted', version: current.version + 1, submittedBy: actor.id, approverId: input.approverId });
}
function approve({ current, actor }: Ready<VersionInput, Submitted>): Result<Approved, never> {
  return ok({ ...current, state: 'approved', version: current.version + 1, approvedBy: actor.id });
}
function reject({ current, actor, input }: Ready<RejectInput, Submitted>): Result<Rejected, never> {
  return ok({ ...current, state: 'rejected', version: current.version + 1, rejectedBy: actor.id, reason: input.reason.trim() });
}
export function createExpenses(ports: Ports) {
  return business({ name: 'expenses', load: ports.load, save: ports.save, operations: {
    submit: { load: ports.load<SubmitInput>, run: [common, submission, submit] },
    approve: [common, approval, approve],
    reject: { load: ports.load<RejectInput>, run: [common, approval, rejection, reject] },
  } });
}
