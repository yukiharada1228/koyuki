import { cancellation, createBookingApp, memoryBookings } from './app.js';
import { cancelBooking, type Booking } from './domain.js';
import type { Result } from 'koyuki';
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
const original: Booking = { kind: 'booked', id: 'one', owner: 'alice' };
const repository = memoryBookings([original]);
const alice = createBookingApp(repository, 'alice'), bob = createBookingApp(repository, 'bob');
check(repository.saves === 0, 'MountMustNotSave');
const forbidden = await bob.execute(cancellation, { id: 'one' });
check(!forbidden.ok && forbidden.error === 'Forbidden' && repository.saves === 0, 'ForbiddenMustNotSave');
const report = await alice.executeDetailed(cancellation, { id: 'one' });
check(report.result.ok && report.result.value.kind === 'cancelled' && repository.saves === 1, 'CancellationFailed');
check(report.trace.some(row => row.step === 'authorize-cancel') && report.trace.some(row => row.step === 'cancel'), 'MissingInternalTrace');
const repeated = await alice.execute(cancellation, { id: 'one' });
check(!repeated.ok && repeated.error === 'AlreadyCancelled' && repository.saves === 1, 'RepeatMustNotSave');
const missing = await alice.execute(cancellation, { id: 'missing' });
check(!missing.ok && missing.error === 'Missing' && repository.saves === 1, 'MissingMustNotSave');
check(original.kind === 'booked', 'InputMustNotMutate');
const pure = cancelBooking.run({ booking: Object.freeze(original), actor: 'alice' });
check(pure.ok && original.kind === 'booked', 'PureCoreMustWorkWithoutProviders');
if (false) {
  // @ts-expect-error The operation infers Input from load.
  void alice.execute(cancellation, { id: 42 });
  // @ts-expect-error Actor is provided by the host, not by request input.
  void alice.execute(cancellation, { id: 'one', actor: 'alice' });
  // @ts-expect-error All domain failures must survive inference.
  const noErrors: Promise<Result<Booking, never>> = alice.execute(cancellation, { id: 'one' });
  void noErrors;
}
console.log('Quick Start: success, failures, single save, pure core, typed input and internal trace passed.');
