import { ok, err, workflow, type Result } from 'koyuki';
export type Booking =
  | { kind: 'booked'; id: string; owner: string }
  | { kind: 'cancelled'; id: string; owner: string };
export type Input = { id: string };
export const cancelBooking = workflow('authorize-cancel',
  ({ booking, actor }: { booking: Booking; actor: string }): Result<Extract<Booking, { kind: 'booked' }>, 'Forbidden' | 'AlreadyCancelled'> => {
    if (booking.owner !== actor) return err('Forbidden');
    return booking.kind === 'booked' ? ok(booking) : err('AlreadyCancelled');
  })
  .then('cancel', booking => ok({ ...booking, kind: 'cancelled' as const }));
