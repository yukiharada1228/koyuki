import { ok, err, workflow, type Result } from 'koyuki';

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

export type Booking =
  | { kind: 'booked'; id: BookingId; owner: ActorId }
  | { kind: 'cancelled'; id: BookingId; owner: ActorId };
export type Input = { id: BookingId };
export const cancelBooking = workflow('authorize-cancel',
  ({ booking, actor }: { booking: Booking; actor: ActorId }): Result<Extract<Booking, { kind: 'booked' }>, 'Forbidden' | 'AlreadyCancelled'> => {
    if (booking.owner !== actor) return err('Forbidden');
    return booking.kind === 'booked' ? ok(booking) : err('AlreadyCancelled');
  })
  .then('cancel', booking => ok({ ...booking, kind: 'cancelled' as const }));
