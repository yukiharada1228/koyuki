import { ok, err, workflow, type Result } from '../../framework/index.js';

// Brands belong to this business model. JSON/DB values must be validated again.
declare const bookingIdBrand: unique symbol;
declare const actorIdBrand: unique symbol;
export type BookingId = string & { readonly [bookingIdBrand]: true };
export type ActorId = string & { readonly [actorIdBrand]: true };
/** Validation failures are ordinary domain values, including at host boundaries. */
export function bookingId(value: unknown): Result<BookingId, 'InvalidBookingId'> {
  return typeof value === 'string' && value.trim() ? ok(value as BookingId) : err('InvalidBookingId');
}
export function actorId(value: unknown): Result<ActorId, 'InvalidActorId'> {
  return typeof value === 'string' && value.trim() ? ok(value as ActorId) : err('InvalidActorId');
}
/** HTTP bodies are unknown; validate before dispatching any business operation. */
export function parseBookingInput(value: unknown): Result<Input, 'InvalidBookingInput' | 'InvalidBookingId'> {
  if (!value || typeof value !== 'object' || !('id' in value)) return err('InvalidBookingInput');
  const id = bookingId(value.id);
  return id.ok ? ok({ id: id.value }) : id;
}

export type Actor = Readonly<{ id: ActorId; role: 'member' | 'manager' }>;
type Details = Readonly<{ id: BookingId; owner: ActorId; startsAt: number }>;
export type Draft = Details & Readonly<{ kind: 'draft' }>;
export type Requested = Details & Readonly<{ kind: 'requested' }>;
export type Confirmed = Details & Readonly<{ kind: 'confirmed'; approvedBy: ActorId }>;
export type Cancelled = Details & Readonly<{ kind: 'cancelled'; approvedBy: ActorId; cancelledBy: ActorId }>;
export type Booking = Draft | Requested | Confirmed | Cancelled;
export type Input = Readonly<{ id: BookingId }>;
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

export function restoreBooking(value: unknown): Result<Booking, 'CorruptBooking'> {
  if (!value || typeof value !== 'object' || !('id' in value) || !('owner' in value) || !('startsAt' in value) || typeof value.startsAt !== 'number' || !Number.isSafeInteger(value.startsAt) || !('kind' in value)) return err('CorruptBooking');
  const id = bookingId(value.id), owner = actorId(value.owner);
  if (!id.ok || !owner.ok) return err('CorruptBooking');
  const details = { id: id.value, owner: owner.value, startsAt: value.startsAt };
  if (value.kind === 'draft' || value.kind === 'requested') return ok(Object.freeze({ ...details, kind: value.kind }));
  if (!('approvedBy' in value)) return err('CorruptBooking');
  const approvedBy = actorId(value.approvedBy);
  if (!approvedBy.ok) return err('CorruptBooking');
  if (value.kind === 'confirmed') return ok(Object.freeze({ ...details, kind: value.kind, approvedBy: approvedBy.value }));
  if (value.kind === 'cancelled' && 'cancelledBy' in value) {
    const cancelledBy = actorId(value.cancelledBy);
    if (cancelledBy.ok) return ok(Object.freeze({ ...details, kind: value.kind, approvedBy: approvedBy.value, cancelledBy: cancelledBy.value }));
  }
  return err('CorruptBooking');
}

export const bookingConfirmedName = 'booking.confirmed.v1';

export type RescheduleInput = Input & Readonly<{ startsAt: number }>;
export type RescheduleChange = Readonly<{ previous: Confirmed; next: Confirmed }>;
export type RescheduleError = 'InvalidState' | 'Forbidden' | 'BookingMismatch' | 'InvalidTime' | 'ReschedulingClosed' | 'Unchanged';
export type RescheduleContext = Readonly<{
  booking: Booking; actor: Actor; request: RescheduleInput;
  time: Readonly<{ now: number; noticeHours: number }>;
}>;
const reschedulingVerified: unique symbol = Symbol('AuthorizedRescheduling');
type AuthorizedRescheduling = Readonly<{ previous: Confirmed; startsAt: number; [reschedulingVerified]: true }>;
export function parseRescheduleInput(value: unknown): Result<RescheduleInput, 'InvalidBookingInput' | 'InvalidBookingId' | 'InvalidRescheduleInput'> {
  const input = parseBookingInput(value);
  if (!input.ok) return input;
  if (!value || typeof value !== 'object' || !('startsAt' in value) || typeof value.startsAt !== 'number' || !Number.isSafeInteger(value.startsAt)) return err('InvalidRescheduleInput');
  return ok({ ...input.value, startsAt: value.startsAt });
}
export function authorizeRescheduling({ booking, actor, request, time }: RescheduleContext): Result<AuthorizedRescheduling, RescheduleError> {
  if (booking.kind !== 'confirmed') return err('InvalidState');
  if (booking.owner !== actor.id) return err('Forbidden');
  if (booking.id !== request.id) return err('BookingMismatch');
  if (!Number.isSafeInteger(time.now) || !Number.isSafeInteger(booking.startsAt) || !Number.isSafeInteger(request.startsAt) || !Number.isFinite(time.noticeHours) || time.noticeHours <= 0 || request.startsAt <= time.now) return err('InvalidTime');
  if (booking.startsAt - time.now < time.noticeHours * 60 * 60 * 1000) return err('ReschedulingClosed');
  if (booking.startsAt === request.startsAt) return err('Unchanged');
  return ok(Object.freeze({ previous: Object.freeze({ ...booking }), startsAt: request.startsAt, [reschedulingVerified]: true as const }));
}
export function reschedule({ previous, startsAt }: AuthorizedRescheduling): Result<RescheduleChange, never> {
  return ok(Object.freeze({ previous, next: Object.freeze({ ...previous, startsAt }) }));
}
export const rescheduling = workflow('authorize-rescheduling', authorizeRescheduling).then('reschedule', reschedule);
export function restoreRescheduleChange(value: unknown): Result<RescheduleChange, 'InvalidReschedulingEvent'> {
  if (!value || typeof value !== 'object' || !('previous' in value) || !('next' in value)) return err('InvalidReschedulingEvent');
  const previous = restoreBooking(value.previous), next = restoreBooking(value.next);
  if (!previous.ok || !next.ok || previous.value.kind !== 'confirmed' || next.value.kind !== 'confirmed' || previous.value.id !== next.value.id || previous.value.owner !== next.value.owner || previous.value.approvedBy !== next.value.approvedBy || previous.value.startsAt === next.value.startsAt) return err('InvalidReschedulingEvent');
  return ok(Object.freeze({ previous: previous.value, next: next.value }));
}
