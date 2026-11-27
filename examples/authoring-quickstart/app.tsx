/** @jsx h */
import { ok, err, type Result } from 'koyuki';
import { h, createContext, useContext, defineOperation, Operation, createApplication } from 'koyuki/experimental';
import { cancelBooking, type Booking, type Input } from './domain.js';
export interface BookingRepository {
  load(input: Input): Promise<Result<Booking, 'Missing'>>;
  save(booking: Booking): Promise<Result<Booking, never>>;
}
export const Bookings = createContext<BookingRepository>();
export const Actor = createContext<string>();
export const cancellation = defineOperation('booking.cancel.v1', () => {
  const repository = useContext(Bookings), actor = useContext(Actor);
  return {
    load: async (input: Input) => {
      const result = await repository.load(input);
      return result.ok ? ok({ booking: result.value, actor }) : result;
    },
    execute: cancelBooking,
    save: booking => repository.save(booking),
  };
});
export function BookingOperations() { return <Operation operation={cancellation} />; }
export function createBookingApp(repository: BookingRepository, authenticatedActor: string) {
  return createApplication(
    <Bookings.Provider value={repository}>
      <Actor.Provider value={authenticatedActor}><BookingOperations /></Actor.Provider>
    </Bookings.Provider>);
}
/** Demo adapter: one process only, no transaction or concurrent-update protection. */
export function memoryBookings(initial: readonly Booking[]) {
  const records = new Map(initial.map(booking => [booking.id, { ...booking }]));
  let saves = 0;
  return {
    get saves() { return saves; },
    async load(input: Input): Promise<Result<Booking, 'Missing'>> {
      const booking = records.get(input.id);
      return booking ? ok({ ...booking }) : err('Missing');
    },
    async save(booking: Booking) { saves++; records.set(booking.id, { ...booking }); return ok(booking); },
  };
}
