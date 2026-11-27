/** @jsx h */
import { ok, err, type Result } from 'koyuki';
import { h, createContext, useContext, defineResource, defineOperation, Operation, createApplicationTemplate } from 'koyuki/experimental';
import { cancelBooking, type Booking, type Input, type ActorId } from './domain.js';
export interface BookingRepository {
  load(input: Input): Promise<Result<Booking, 'Missing'>>;
  save(booking: Booking): Promise<Result<Booking, never>>;
}
export const Bookings = createContext<BookingRepository>();
export const Actor = createContext<ActorId>();
const currentBooking = defineResource('current-booking', () => {
  const repository = useContext(Bookings);
  return (input: Input) => repository.load(input);
});
export const authenticatedActor = defineResource('authenticated-actor', () => {
  const actor = useContext(Actor);
  return () => ok(actor);
});
export const cancellation = defineOperation('booking.cancel.v1', {
  needs: { booking: currentBooking, actor: authenticatedActor },
  execute: cancelBooking,
  useSave: () => { const repository = useContext(Bookings); return (booking: Booking) => repository.save(booking); },
});
export function BookingOperations() { return <Operation operation={cancellation} />; }
export function createBookingApp(repository: BookingRepository) {
  return createApplicationTemplate(
    <Bookings.Provider value={repository}><BookingOperations /></Bookings.Provider>);
}
/** Demo adapter: one process only, no transaction or concurrent-update protection. */
export function memoryBookings(initial: readonly Booking[]) {
  const records = new Map(initial.map(booking => [booking.id, { ...booking }]));
  let saves = 0, loads = 0;
  return {
    get saves() { return saves; },
    get loads() { return loads; },
    async load(input: Input): Promise<Result<Booking, 'Missing'>> {
      loads++; const booking = records.get(input.id);
      return booking ? ok({ ...booking }) : err('Missing');
    },
    async save(booking: Booking) { saves++; records.set(booking.id, { ...booking }); return ok(booking); },
  };
}
