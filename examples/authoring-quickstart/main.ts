import { cancellation, createBookingApp, memoryBookings } from './app.js';
const repository = memoryBookings([{ kind: 'booked', id: 'booking-1', owner: 'alice' }]);
// The host supplies an authenticated identity, not a field from the request body.
const app = createBookingApp(repository, 'alice');
console.log(await app.execute(cancellation, { id: 'booking-1' }));
// { ok: true, value: { kind: 'cancelled', id: 'booking-1', owner: 'alice' } }
