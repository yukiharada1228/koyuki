/** @jsx h */
import { h } from 'koyuki/experimental';
import { collect } from 'koyuki';
import { bookingId, actorId } from './domain.js';
import { Actor, cancellation, createBookingApp, memoryBookings } from './app.js';
async function main() {
  const seed = collect({ id: bookingId('booking-1'), actor: actorId('alice') });
  if (!seed.ok) return seed;
  const { id, actor } = seed.value;
  const repository = memoryBookings([{ kind: 'booked', id, owner: actor }]);
  const app = createBookingApp(repository).scope(children => <Actor.Provider value={actor}>{children}</Actor.Provider>);
  // This executes and saves once; it is not a read-only inspection.
  const report = await app.executeDetailed(cancellation, { id });
  console.log(report.trace);
  if (repository.saves !== 1) throw new Error('ExpectedOneSave');
  return report.result;
}
console.log(await main());
