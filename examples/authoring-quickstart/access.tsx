/** @jsx h */
import { ok, err, collect } from 'koyuki';
import { h, Guard, ExecutionDenied, createContext, useContext, createApplicationTemplate } from 'koyuki/experimental';
import { Actor, Bookings, BookingOperations, cancellation, memoryBookings } from './app.js';
import { bookingId, actorId } from './domain.js';
const Permission = createContext<boolean>();
async function main() {
  const seed = collect({ id: bookingId('booking-1'), actor: actorId('alice') });
  if (!seed.ok) return seed;
  const { id, actor } = seed.value;
  const repository = memoryBookings([{ kind: 'booked', id, owner: actor }]);
  const template = createApplicationTemplate(<Bookings.Provider value={repository}>
    <Guard useCheck={() => { const allowed = useContext(Permission); return () => allowed ? ok(undefined) : err('CancellationDisabled'); }}>
      <BookingOperations />
    </Guard>
  </Bookings.Provider>);
  const scoped = (allowed: boolean) => template.scope(children =>
    <Actor.Provider value={actor}><Permission.Provider value={allowed}>{children}</Permission.Provider></Actor.Provider>);
  try { await scoped(false).execute(cancellation, { id }); throw new Error('ExpectedDenial'); }
  catch (error) { if (!(error instanceof ExecutionDenied) || error.reason !== 'CancellationDisabled') throw error; }
  if ([repository.loads, repository.saves].some(count => count !== 0)) throw new Error('DeniedMustNotPerformIO');
  const result = await scoped(true).execute(cancellation, { id });
  if (!result.ok || repository.saves !== 1) throw new Error('AllowedMustSaveOnce');
  console.log('Guard: denial before IO, allowed execution and scoped identity passed.');
  return result;
}
console.log(await main());
