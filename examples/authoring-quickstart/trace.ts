import { cancellation, createBookingApp, memoryBookings } from './app.js';
const repository = memoryBookings([{ kind: 'booked', id: 'booking-1', owner: 'alice' }]);
const app = createBookingApp(repository, 'alice');
// This executes and saves once; it is not a read-only inspection.
const report = await app.executeDetailed(cancellation, { id: 'booking-1' });
console.log(report.result);
console.log(report.trace);
if (repository.saves !== 1) throw new Error('ExpectedOneSave');
