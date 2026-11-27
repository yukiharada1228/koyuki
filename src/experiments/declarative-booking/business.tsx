/** @jsx h */
import { ok, err, workflow, type Result, type Execution, type Receipt } from '../../framework/index.js';
import { h, Fragment, createContext, useContext, defineResource, defineEvent, emit, defineOperation, Operation, On, type EventEnvelope } from '../../framework/authoring.js';
import { submission, approval, restoreBooking, bookingConfirmedName, type Booking, type Confirmed, type Requested, type Actor, type Input, type BookingId, type ActorId } from './domain.js';
export interface BookingRepository {
  load(input: Input): Promise<Result<Booking, 'Missing' | 'StorageFailed'>>;
  approvalReceipt(input: Input, actor: Actor): Promise<Result<Receipt<Confirmed>, 'StorageFailed'>>;
  /** Persist state and events atomically; enqueueing outside this save is unsafe. */
  commit<S extends Booking>(booking: S, input: Input, events: readonly EventEnvelope[]): Promise<Result<Extract<Execution<S>, { kind: 'committed' }>, 'StorageFailed'>>;
}
export interface Mail { readonly bookingId: BookingId; readonly owner: ActorId }
export interface MailSender { send(mail: Mail): Promise<Result<null, 'DeliveryUnavailable'>> }
export const Bookings = createContext<BookingRepository>();
export const ActorContext = createContext<Actor>();
export const MailContext = createContext<MailSender>();
const booking = defineResource('current-booking', () => {
  const repository = useContext(Bookings);
  return (input: Input) => repository.load(input);
});
export const authenticatedActor = defineResource('authenticated-actor', () => {
  const actor = Object.freeze({ ...useContext(ActorContext) });
  return () => ok(actor);
});
export const bookingConfirmed = defineEvent<Confirmed>(bookingConfirmedName, {
  decode(value) {
    const restored = restoreBooking(value);
    return restored.ok && restored.value.kind === 'confirmed' ? ok(restored.value) : err('InvalidBookingEvent');
  },
});
function useSaveBooking() {
  const repository = useContext(Bookings);
  return <S extends Booking>(value: S, input: Input, events: readonly EventEnvelope[]) => repository.commit(value, input, events);
}
export const submitBooking = defineOperation('booking.submit.v1', {
  needs: { booking, actor: authenticatedActor }, execute: submission, useSave: useSaveBooking,
});
export const approveBooking = defineOperation('booking.approve.v1', {
  needs: { booking, actor: authenticatedActor }, execute: approval, useSave: useSaveBooking,
  emits: [emit(bookingConfirmed)],
});
/** Optional policy: explicitly delegate approval to this host-supplied actor. */
export const bookingRequested = defineEvent<Requested>('booking.requested.v1', {
  decode(value) {
    const restored = restoreBooking(value);
    return restored.ok && restored.value.kind === 'requested' ? ok(restored.value) : err('InvalidBookingRequestEvent');
  },
});
export const requestAutomaticApproval = defineOperation('booking.request-automatic.v1', {
  needs: { booking, actor: authenticatedActor }, execute: submission, useSave: useSaveBooking, emits: [emit(bookingRequested)],
});
export const automaticallyApproveBooking = defineOperation('booking.approve-automatic.v1', {
  needs: { booking, actor: authenticatedActor }, execute: approval, emits: [emit(bookingConfirmed)],
  useSave: useSaveBooking,
  useReplay: () => {
    const repository = useContext(Bookings), actor = Object.freeze({ ...useContext(ActorContext) });
    return {
      lookup: async (input: Input): Promise<Result<Receipt<Confirmed>, 'StorageFailed' | 'Forbidden'>> => actor.role === 'manager' ? repository.approvalReceipt(input, actor) : err('Forbidden'),
      resolveAfter: (error: 'Missing' | 'StorageFailed' | 'InvalidState' | 'Forbidden' | 'SelfApproval') => error === 'StorageFailed' || error === 'InvalidState',
    };
  },
});
export function AutomaticBookingBusiness({ repository, approver }: { repository: BookingRepository; approver: Actor }) {
  return <Bookings.Provider value={repository}><Fragment>
    <Operation operation={requestAutomaticApproval} />
    <ActorContext.Provider value={approver}><On event={bookingRequested} operation={automaticallyApproveBooking} /></ActorContext.Provider>
  </Fragment></Bookings.Provider>;
}
const confirmedEvent = defineResource('confirmed-event', () => (event: Confirmed) => ok(event));
export const notifyBooking = defineOperation('booking.notify.v1', {
  needs: { booking: confirmedEvent },
  execute: workflow('prepare-booking-mail', ({ booking }: { booking: Confirmed }) => ok({ bookingId: booking.id, owner: booking.owner })),
  useSave: () => { const sender = useContext(MailContext); return (mail: Mail) => sender.send(mail); },
});
export function BookingBusiness({ repository }: { repository: BookingRepository }) {
  return <Bookings.Provider value={repository}><Fragment><Operation operation={submitBooking} /><Operation operation={approveBooking} /></Fragment></Bookings.Provider>;
}
export function NotificationBusiness({ sender }: { sender: MailSender }) {
  return <MailContext.Provider value={sender}><On event={bookingConfirmed} operation={notifyBooking} /></MailContext.Provider>;
}
