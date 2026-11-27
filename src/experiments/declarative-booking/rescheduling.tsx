/** @jsx h */
import { ok, workflow, type Result, type Execution, type Receipt } from '../../framework/index.js';
import { h, createContext, useContext, defineResource, defineEvent, emit, defineOperation, Operation, On, type EventEnvelope } from '../../framework/authoring.js';
import { ActorContext, authenticatedActor, type BookingRepository } from './business.js';
import { rescheduling, restoreRescheduleChange, type RescheduleInput, type RescheduleError, type RescheduleChange, type Confirmed, type BookingId, type ActorId } from './domain.js';
import { parseRescheduleRequest, type RescheduleRequest, type RescheduleRequestError, type ReschedulingIdentity } from './rescheduling-request.js';
export type ReschedulingStorageError = 'ConcurrentChange' | 'StorageFailed' | 'IdempotencyConflict';
export interface ReschedulingRepository extends Pick<BookingRepository, 'load'> {
  reschedulingReceipt(input: RescheduleRequest, identity: ReschedulingIdentity): Promise<Result<Receipt<Confirmed>, 'StorageFailed' | 'IdempotencyConflict'>>;
  reschedule(change: RescheduleChange, input: RescheduleRequest, events: readonly EventEnvelope[], identity: ReschedulingIdentity): Promise<Result<Execution<Confirmed>, ReschedulingStorageError>>;
}
export interface ReschedulingNotice { readonly bookingId: BookingId; readonly owner: ActorId; readonly previousStartsAt: number; readonly startsAt: number }
export interface ReschedulingSender { send(notice: ReschedulingNotice): Promise<Result<null, 'DeliveryUnavailable'>> }
const Repository = createContext<ReschedulingRepository>();
const Policy = createContext<Readonly<{ clock: () => number; noticeHours: number }>>();
const Sender = createContext<ReschedulingSender>();
const current = defineResource('current-booking', () => {
  const repository = useContext(Repository);
  return (input: RescheduleRequest) => repository.load(input);
});
const request = defineResource('rescheduling-request', () => (input: RescheduleRequest): Result<RescheduleInput, never> => ok({ id: input.id, startsAt: input.startsAt }));
const time = defineResource('rescheduling-time', () => {
  const { clock, noticeHours } = useContext(Policy);
  return () => ok({ now: clock(), noticeHours });
});
export const bookingRescheduled = defineEvent<RescheduleChange>('booking.rescheduled.v1', { decode: restoreRescheduleChange });
function useRequestIdentity() {
  const actorId = useContext(ActorContext).id;
  return (input: RescheduleRequest): Result<ReschedulingIdentity, RescheduleRequestError> => {
    const parsed = parseRescheduleRequest(input);
    if (!parsed.ok) return parsed;
    return ok({ actorId, key: parsed.value.requestId, fingerprint: JSON.stringify([rescheduleBooking.name, parsed.value.id, parsed.value.startsAt, actorId]) });
  };
}
export const rescheduleBooking = defineOperation('booking.reschedule.v1', {
  needs: { booking: current, actor: authenticatedActor, request, time },
  execute: rescheduling,
  emits: [emit(bookingRescheduled)],
  useSave: () => {
    const repository = useContext(Repository), identify = useRequestIdentity();
    return async (change: RescheduleChange, input: RescheduleRequest, events: readonly EventEnvelope[]) => {
      const identity = identify(input);
      return identity.ok ? repository.reschedule(change, input, events, identity.value) : identity;
    };
  },
  useReplay: () => {
    const repository = useContext(Repository), identify = useRequestIdentity();
    return {
      lookup: async (input: RescheduleRequest): Promise<Result<Receipt<Confirmed>, 'StorageFailed' | 'IdempotencyConflict' | RescheduleRequestError>> => {
        const identity = identify(input);
        return identity.ok ? repository.reschedulingReceipt(input, identity.value) : identity;
      },
      // A concurrent receipt may win while current state is loading. Look up the
      // receipt after expected failures; never repeat the domain computation.
      resolveAfter: (error: RescheduleError | 'Missing' | ReschedulingStorageError | RescheduleRequestError) => error !== 'IdempotencyConflict',
    };
  },
});
export function ReschedulingBusiness({ repository, clock, noticeHours }: { repository: ReschedulingRepository; clock: () => number; noticeHours: number }) {
  if (!Number.isFinite(noticeHours) || noticeHours <= 0) throw new Error('InvalidReschedulingNoticeHours');
  return <Repository.Provider value={repository}><Policy.Provider value={Object.freeze({ clock, noticeHours })}><Operation operation={rescheduleBooking} /></Policy.Provider></Repository.Provider>;
}
const change = defineResource('rescheduling-event', () => (input: RescheduleChange) => ok(input));
export const notifyRescheduling = defineOperation('booking.notify-rescheduling.v1', {
  needs: change,
  execute: workflow('prepare-rescheduling-notice', ({ previous, next }: RescheduleChange) => ok({ bookingId: next.id, owner: next.owner, previousStartsAt: previous.startsAt, startsAt: next.startsAt })),
  useSave: () => { const sender = useContext(Sender); return (notice: ReschedulingNotice) => sender.send(notice); },
});
export function ReschedulingNotifications({ sender }: { sender: ReschedulingSender }) {
  return <Sender.Provider value={sender}><On event={bookingRescheduled} operation={notifyRescheduling} /></Sender.Provider>;
}
