import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import type { ReschedulingRepository } from './rescheduling.js';
import type { RescheduleRequest, ReschedulingIdentity } from './rescheduling-request.js';
import type { BookingRepository } from './business.js';
import { restoreBooking, bookingConfirmedName, type Booking, type Confirmed, type Actor, type Input } from './domain.js';
/** Demo only: records and outbox are replaced together without yielding. */
export function memoryBookings(initial: readonly Booking[]) {
  const records = new Map(initial.map(booking => [booking.id, Object.freeze({ ...booking })]));
  const events: EventEnvelope[] = [], acknowledged = new Set<string>();
  const receipts = new Map<string, { fingerprint: string; value: Confirmed }>();
  const lookup = (input: RescheduleRequest, identity: ReschedulingIdentity): Result<Receipt<Confirmed>, 'StorageFailed' | 'IdempotencyConflict'> => {
    if (identity.key !== input.requestId) return err('StorageFailed');
    const receipt = receipts.get(identity.key);
    if (!receipt) return ok({ kind: 'missing' });
    if (receipt.fingerprint !== identity.fingerprint) return err('IdempotencyConflict');
    const restored = restoreBooking(receipt.value);
    return restored.ok && restored.value.kind === 'confirmed' && restored.value.id === input.id && restored.value.owner === identity.actorId && restored.value.startsAt === input.startsAt
      ? ok({ kind: 'found', value: restored.value }) : err('StorageFailed');
  };
  const repository: BookingRepository & ReschedulingRepository = {
    async load(input: Input) { const booking = records.get(input.id); return booking ? ok({ ...booking }) : err('Missing'); },
    async approvalReceipt(input: Input, actor: Actor): Promise<Result<Receipt<Confirmed>, 'StorageFailed'>> {
      for (const event of events) if (event.type === bookingConfirmedName) {
        const restored = restoreBooking(event.payload);
        if (!restored.ok || restored.value.kind !== 'confirmed') return err('StorageFailed');
        if (restored.value.id === input.id && restored.value.approvedBy === actor.id) return ok({ kind: 'found', value: restored.value });
      }
      return ok({ kind: 'missing' });
    },
    async reschedulingReceipt(input, identity) { return lookup(input, identity); },
    async reschedule(change, input, emitted, identity) {
      const cached = lookup(input, identity);
      if (!cached.ok) return cached;
      if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
      const { previous, next } = change;
      if (previous.id !== input.id || next.id !== input.id || previous.owner !== identity.actorId || previous.owner !== next.owner || previous.approvedBy !== next.approvedBy || next.startsAt !== input.startsAt) return err('StorageFailed');
      const current = records.get(input.id);
      if (!current || current.kind !== 'confirmed' || current.startsAt !== previous.startsAt || current.owner !== previous.owner || current.approvedBy !== previous.approvedBy) return err('ConcurrentChange');
      const publications = structuredClone(emitted);
      const saved = Object.freeze({ ...next }), receipt = Object.freeze({ ...next });
      records.set(next.id, saved); events.push(...publications);
      receipts.set(identity.key, { fingerprint: identity.fingerprint, value: receipt });
      return ok({ kind: 'committed', value: next });
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
