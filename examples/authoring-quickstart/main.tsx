/** @jsx h */
import { h } from 'koyuki/experimental';
import { collect } from 'koyuki';
import { bookingId, actorId, parseBookingInput } from './domain.js';
import { Actor, cancellation, createBookingApp, memoryBookings } from './app.js';
async function main() {
  const seed = collect({ id: bookingId('booking-1'), actor: actorId('alice') });
  if (!seed.ok) return seed;
  const { id, actor } = seed.value;
  const repository = memoryBookings([{ kind: 'booked', id, owner: actor }]);
  // The host supplies an authenticated identity, not a request-body actor.
  const app = createBookingApp(repository).scope(children => <Actor.Provider value={actor}>{children}</Actor.Provider>);
  const body: unknown = JSON.parse('{"id":"booking-1"}');
  const input = parseBookingInput(body);
  if (!input.ok) return input; // HTTP host maps this expected failure to a 400.
  return app.execute(cancellation, input.value);
}
console.log(await main());
// { ok: true, value: { kind: 'cancelled', id: 'booking-1', owner: 'alice' } }
