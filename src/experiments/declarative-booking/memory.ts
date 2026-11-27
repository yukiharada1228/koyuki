import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import type { BookingRepository } from './business.js';
import { restoreBooking, bookingConfirmedName, type Booking, type Confirmed, type Actor, type Input } from './domain.js';
/** Demo only: records and outbox are replaced together without yielding. */
export function memoryBookings(initial: readonly Booking[]) {
  const records = new Map(initial.map(booking => [booking.id, Object.freeze({ ...booking })]));
  const events: EventEnvelope[] = [], acknowledged = new Set<string>();
  const repository: BookingRepository = {
    async load(input: Input) { const booking = records.get(input.id); return booking ? ok({ ...booking }) : err('Missing'); },
    async approvalReceipt(input: Input, actor: Actor): Promise<Result<Receipt<Confirmed>, 'StorageFailed'>> {
      for (const event of events) if (event.type === bookingConfirmedName) {
        const restored = restoreBooking(event.payload);
        if (!restored.ok || restored.value.kind !== 'confirmed') return err('StorageFailed');
        if (restored.value.id === input.id && restored.value.approvedBy === actor.id) return ok({ kind: 'found', value: restored.value });
      }
      return ok({ kind: 'missing' });
    },
    async commit<S extends Booking>(booking: S, input: Input, emitted: readonly EventEnvelope[]): Promise<Result<Extract<Execution<S>, { kind: 'committed' }>, 'StorageFailed'>> {
      const current = records.get(input.id), previous = booking.kind === 'requested' ? 'draft' : booking.kind === 'confirmed' ? 'requested' : undefined;
      if (!previous || !current || current.kind !== previous || booking.id !== input.id) return err('StorageFailed');
      const publications = structuredClone(emitted);
      records.set(booking.id, Object.freeze({ ...booking })); events.push(...publications);
      return ok({ kind: 'committed', value: booking });
    },
  };
  return { ...repository, pending: () => structuredClone(events.filter(event => !acknowledged.has(event.id))), acknowledge: (id: string) => { acknowledged.add(id); } };
}
