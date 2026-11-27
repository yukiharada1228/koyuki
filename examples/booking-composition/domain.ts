import { ok, err, workflow, type Result } from 'koyuki';
export type Actor = Readonly<{ id: string; role: 'member' | 'manager' }>;
type Details = Readonly<{ id: string; owner: string; startsAt: number }>;
export type Draft = Details & Readonly<{ kind: 'draft' }>;
export type Requested = Details & Readonly<{ kind: 'requested' }>;
export type Confirmed = Details & Readonly<{ kind: 'confirmed'; approvedBy: string }>;
export type Cancelled = Details & Readonly<{ kind: 'cancelled'; approvedBy: string; cancelledBy: string }>;
export type Booking = Draft | Requested | Confirmed | Cancelled;
export type Input = Readonly<{ id: string }>;
export type Context = Readonly<{ booking: Booking; actor: Actor }>;
export type CancellationContext = Context & Readonly<{ now: number; cancellationHours: number }>;
const verified: unique symbol = Symbol('VerifiedBooking');
type Verified<S> = Readonly<{ booking: S; actor: Actor; [verified]: true }>;
export function validateSubmission({ booking, actor }: Context): Result<Verified<Draft>, 'InvalidState' | 'Forbidden'> {
  if (booking.kind !== 'draft') return err('InvalidState');
  if (booking.owner !== actor.id) return err('Forbidden');
  return ok(Object.freeze({ booking: Object.freeze({ ...booking }), actor: Object.freeze({ ...actor }), [verified]: true }));
}
export function submit({ booking }: Verified<Draft>): Result<Requested, never> { return ok(Object.freeze({ ...booking, kind: 'requested' })); }
export function validateApproval({ booking, actor }: Context): Result<Verified<Requested>, 'InvalidState' | 'Forbidden' | 'SelfApproval'> {
  if (booking.kind !== 'requested') return err('InvalidState');
  if (actor.role !== 'manager') return err('Forbidden');
  if (actor.id === booking.owner) return err('SelfApproval');
  return ok(Object.freeze({ booking: Object.freeze({ ...booking }), actor: Object.freeze({ ...actor }), [verified]: true }));
}
export function approve({ booking, actor }: Verified<Requested>): Result<Confirmed, never> { return ok(Object.freeze({ ...booking, kind: 'confirmed', approvedBy: actor.id })); }
export function validateCancellation({ booking, actor, now, cancellationHours }: CancellationContext): Result<Verified<Confirmed>, 'InvalidState' | 'Forbidden' | 'InvalidTime' | 'CancellationClosed'> {
  if (booking.kind !== 'confirmed') return err('InvalidState');
  if (booking.owner !== actor.id) return err('Forbidden');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(booking.startsAt) || !Number.isFinite(cancellationHours) || cancellationHours <= 0) return err('InvalidTime');
  if (booking.startsAt - now < cancellationHours * 60 * 60 * 1000) return err('CancellationClosed');
  return ok(Object.freeze({ booking: Object.freeze({ ...booking }), actor: Object.freeze({ ...actor }), [verified]: true }));
}
export function cancel({ booking, actor }: Verified<Confirmed>): Result<Cancelled, never> { return ok(Object.freeze({ ...booking, kind: 'cancelled', cancelledBy: actor.id })); }
export const submission = workflow('validate-submission', validateSubmission).then('submit', submit);
export const approval = workflow('validate-approval', validateApproval).then('approve', approve);
export const cancellation = workflow('validate-cancellation', validateCancellation).then('cancel', cancel);
