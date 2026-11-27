/** @jsx h */
import { h } from 'koyuki/experimental';
import { bookingId, actorId, parseBookingInput } from './domain.js';
import { Actor, cancellation, createBookingApp, memoryBookings } from './app.js';
import { cancelBooking, type Booking } from './domain.js';
import type { Result } from 'koyuki';
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
const original: Booking = { kind: 'booked', id: valid(bookingId('one')), owner: valid(actorId('alice')) };
const repository = memoryBookings([original]);
const template = createBookingApp(repository);
const alice = template.scope(children => <Actor.Provider value={valid(actorId('alice'))}>{children}</Actor.Provider>);
const bob = template.scope(children => <Actor.Provider value={valid(actorId('bob'))}>{children}</Actor.Provider>);
check(repository.saves === 0, 'MountMustNotSave');
check(!parseBookingInput({ id: ' ' }).ok && !parseBookingInput({ id: 12 }).ok, 'InvalidInputMustBeRejected');
const forbidden = await bob.execute(cancellation, { id: valid(bookingId('one')) });
check(!forbidden.ok && forbidden.error === 'Forbidden' && repository.saves === 0, 'ForbiddenMustNotSave');
const report = await alice.executeDetailed(cancellation, { id: valid(bookingId('one')) });
check(report.result.ok && report.result.value.kind === 'cancelled' && repository.saves === 1, 'CancellationFailed');
check(report.trace.some(row => row.step === 'authorize-cancel') && report.trace.some(row => row.step === 'cancel'), 'MissingInternalTrace');
const repeated = await alice.execute(cancellation, { id: valid(bookingId('one')) });
check(!repeated.ok && repeated.error === 'AlreadyCancelled' && repository.saves === 1, 'RepeatMustNotSave');
const missing = await alice.execute(cancellation, { id: valid(bookingId('missing')) });
check(!missing.ok && missing.error === 'Missing' && repository.saves === 1, 'MissingMustNotSave');
check(original.kind === 'booked', 'InputMustNotMutate');
const pure = cancelBooking.run({ booking: Object.freeze(original), actor: valid(actorId('alice')) });
check(pure.ok && original.kind === 'booked', 'PureCoreMustWorkWithoutProviders');
if (false) {
  // @ts-expect-error A validated actor ID is still not a booking ID.
  void alice.execute(cancellation, { id: valid(actorId('one')) });
  // @ts-expect-error The authenticated identity cannot be a booking ID.
  void template.scope(children => <Actor.Provider value={valid(bookingId('alice'))}>{children}</Actor.Provider>);
  // @ts-expect-error Raw strings must pass a checked constructor or parser.
  void alice.execute(cancellation, { id: 'one' });
  // @ts-expect-error The operation infers Input from load.
  void alice.execute(cancellation, { id: 42 });
  // @ts-expect-error Actor is provided by the host, not by request input.
  void alice.execute(cancellation, { id: valid(bookingId('one')), actor: valid(actorId('alice')) });
  // @ts-expect-error All domain failures must survive inference.
  const noErrors: Promise<Result<Booking, never>> = alice.execute(cancellation, { id: valid(bookingId('one')) });
  void noErrors;
}
console.log('Quick Start: success, failures, single save, pure core, typed input and internal trace passed.');

// Only known test seeds use this assertion; external failures remain Result values.
function valid<T, E>(result: import('koyuki').Result<T, E>): T {
  if (!result.ok) throw new Error('InvalidTestFixture:' + result.error);
  return result.value;
}
