import { createBookingApplication, BookingBusiness, ActorContext } from './component.js';
import { createBookingService } from './functions.js';
import { memoryRepository } from './definitions.js';
import { cancel, bookingId, actorId, type Booking } from './domain.js';
import { h, createApplication } from 'koyuki/experimental';
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string) { check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`); }
type Factory = typeof createBookingApplication;
const hour = 60 * 60 * 1000, startsAt = Date.UTC(2030, 0, 3);
const confirmed = (owner: string): Booking => ({ kind: 'confirmed', id: valid(bookingId('same-id')), owner: valid(actorId(owner)), startsAt, approvedBy: valid(actorId('boss')) });
async function scenario(factory: Factory) {
  let now = startsAt - 36 * hour, reads = 0;
  const clock = () => { reads++; return now; };
  const repositoryA = memoryRepository([confirmed('alice')]), repositoryB = memoryRepository([confirmed('bob')]);
  const actorA = { id: valid(actorId('alice')), role: 'member' as const }, actorB = { id: valid(actorId('bob')), role: 'member' as const };
  const propsA = { repository: repositoryA, cancellationHours: 24, clock };
  const propsB = { repository: repositoryB, cancellationHours: 48, clock };
  const a = factory(propsA, actorA), b = factory(propsB, actorB);
  check(reads === 0 && repositoryA.loads === 0 && repositoryB.loads === 0, 'ConstructionMustNotPerformIO');
  // Provider captures are snapshots; later caller-owned mutation is not a rerender.
  propsA.cancellationHours = 96; propsB.cancellationHours = 1; actorA.id = valid(actorId('intruder')); actorB.id = valid(actorId('intruder'));
  const [allowed, denied] = await Promise.all([a.detailed.cancel({ id: valid(bookingId('same-id')) }), b.detailed.cancel({ id: valid(bookingId('same-id')) })]);
  check(allowed.result.ok && allowed.result.value.kind === 'cancelled' && allowed.result.value.cancelledBy === 'alice', '24hPolicyAndActorSnapshot');
  check(!denied.result.ok && denied.result.error === 'CancellationClosed', '48hPolicyAndActorSnapshot');
  check(repositoryA.saves === 1 && repositoryB.saves === 0, 'RepositoryIsolation');
  check(!denied.trace.some(row => row.step === 'cancel'), 'FailureMustStop');
  now = startsAt - 48 * hour;
  const boundary = await b.cancel({ id: valid(bookingId('same-id')) });
  check(boundary.ok && boundary.value.kind === 'cancelled' && boundary.value.cancelledBy === 'bob', 'ClockMustBeReadOnExecution');
  check(reads === 3, 'OneClockReadPerCancellation');
  const repeated = await a.cancel({ id: valid(bookingId('same-id')) });
  check(!repeated.ok && repeated.error === 'InvalidState' && repositoryA.saves === 1, 'RepeatedCancellationMustNotSave');
  const missing = await a.cancel({ id: valid(bookingId('missing')) });
  check(!missing.ok && missing.error === 'Missing', 'Missing');
  const boundaryResults = [];
  for (const cancellationHours of [24, 48]) for (const offset of [-1, 0, 1]) {
    const repo = memoryRepository([confirmed('alice')]);
    const app = factory({ repository: repo, cancellationHours, clock: () => startsAt - cancellationHours * hour + offset }, { id: valid(actorId('alice')), role: 'member' });
    const result = await app.cancel({ id: valid(bookingId('same-id')) });
    check(offset <= 0 ? result.ok && repo.saves === 1 : !result.ok && result.error === 'CancellationClosed' && repo.saves === 0, 'DeadlineBoundary');
    boundaryResults.push(result);
  }
  // Same component/service, new policy prop only: change outcome at 36h.
  const changedPolicy = await factory({ repository: memoryRepository([confirmed('bob')]), cancellationHours: 24, clock: () => startsAt - 36 * hour }, { id: valid(actorId('bob')), role: 'member' }).cancel({ id: valid(bookingId('same-id')) });
  check(changedPolicy.ok, 'PolicyPropOnlyChange');
  const draft: Booking = Object.freeze({ kind: 'draft', id: valid(bookingId('lifecycle')), owner: valid(actorId('alice')), startsAt });
  const repository = memoryRepository([draft]);
  const props = { repository, cancellationHours: 24, clock: () => startsAt - 36 * hour };
  const owner = factory(props, { id: valid(actorId('alice')), role: 'member' }), manager = factory(props, { id: valid(actorId('boss')), role: 'manager' });
  const submitted = await owner.submit({ id: valid(bookingId('lifecycle')) });
  check(submitted.ok && submitted.value.kind === 'requested', 'Submission');
  const forbiddenApproval = await owner.approve({ id: valid(bookingId('lifecycle')) });
  check(!forbiddenApproval.ok && forbiddenApproval.error === 'Forbidden' && repository.saves === 1, 'ApprovalAuthorization');
  const selfApproval = await factory(props, { id: valid(actorId('alice')), role: 'manager' }).approve({ id: valid(bookingId('lifecycle')) });
  check(!selfApproval.ok && selfApproval.error === 'SelfApproval' && repository.saves === 1, 'SelfApproval');
  const approved = await manager.approve({ id: valid(bookingId('lifecycle')) });
  check(approved.ok && approved.value.kind === 'confirmed' && approved.value.approvedBy === 'boss', 'Approval');
  const forbiddenCancellation = await manager.cancel({ id: valid(bookingId('lifecycle')) });
  check(!forbiddenCancellation.ok && forbiddenCancellation.error === 'Forbidden' && repository.saves === 2, 'CancellationAuthorization');
  const cancelled = await owner.cancel({ id: valid(bookingId('lifecycle')) });
  check(cancelled.ok && cancelled.value.kind === 'cancelled' && repository.saves === 3, 'Lifecycle');
  check(draft.kind === 'draft', 'OriginalMustNotMutate');
  const failedRepo = memoryRepository([confirmed('alice')], true);
  const failedSave = await factory({ repository: failedRepo, cancellationHours: 24, clock: () => startsAt - 36 * hour }, { id: valid(actorId('alice')), role: 'member' }).cancel({ id: valid(bookingId('same-id')) });
  check(!failedSave.ok && failedSave.error === 'Conflict' && failedRepo.saves === 0, 'SaveError');
  const badTime = await factory({ ...props, repository: memoryRepository([confirmed('alice')]), clock: () => NaN }, { id: valid(actorId('alice')), role: 'member' }).cancel({ id: valid(bookingId('same-id')) });
  check(!badTime.ok && badTime.error === 'InvalidTime', 'InvalidClock');
  for (const cancellationHours of [0, -1, NaN, Infinity]) {
    let rejected = false;
    try { factory({ ...props, cancellationHours }, { id: valid(actorId('alice')), role: 'member' }); } catch (error) { rejected = error instanceof Error && error.message === 'InvalidCancellationHours'; }
    check(rejected, 'InvalidConfiguration');
  }
  return { allowed: { result: allowed.result, trace: allowed.trace }, denied: { result: denied.result, trace: denied.trace }, boundary, repeated, missing, boundaryResults, changedPolicy, submitted, forbiddenApproval, selfApproval, approved, forbiddenCancellation, cancelled, failedSave, badTime };
}
const jsx = await scenario(createBookingApplication);
const functions = await scenario(createBookingService);
equal(jsx, functions, 'JSXAndFunctionsMustHaveTheSameBusinessResultsAndTrace');
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type JSXError = Extract<Awaited<ReturnType<ReturnType<typeof createBookingApplication>['cancel']>>, { ok: false }>['error'];
type FunctionError = Extract<Awaited<ReturnType<ReturnType<typeof createBookingService>['cancel']>>, { ok: false }>['error'];
const exactJSX: Equal<JSXError, 'Missing' | 'Conflict' | 'InvalidState' | 'Forbidden' | 'InvalidTime' | 'CancellationClosed'> = true;
const exactFunctions: Equal<JSXError, FunctionError> = true;
void exactJSX; void exactFunctions;
if (false) {
  const typedApp = createBookingApplication({ repository: memoryRepository([]), cancellationHours: 24, clock: () => startsAt }, { id: valid(actorId('alice')), role: 'member' });
  // @ts-expect-error Authenticated actors cannot identify a booking.
  void typedApp.cancel({ id: valid(actorId('one')) });
  const props = { repository: memoryRepository([]), cancellationHours: 24, clock: () => startsAt };
  const app = createBookingApplication(props, { id: valid(actorId('alice')), role: 'member' });
  // @ts-expect-error Request input is inferred through the component assembly.
  void app.cancel({ id: 1 });
  // @ts-expect-error Actor is trusted Provider data, not a command field.
  void app.cancel({ id: valid(bookingId('one')), actor: { id: valid(actorId('boss')), role: 'manager' } });
  // @ts-expect-error Policy props retain their types.
  void BookingBusiness({ ...props, cancellationHours: '48' });
  // @ts-expect-error Pure transitions require the successful validation proof.
  void cancel({ booking: confirmed('alice'), actor: { id: valid(actorId('alice')), role: 'member' } });
}
const duplicateProps = { repository: memoryRepository([]), cancellationHours: 24, clock: () => startsAt };
let duplicateRejected = false;
try {
  createApplication(h(ActorContext.Provider, {
    value: { id: valid(actorId('alice')), role: 'member' },
    children: [h(BookingBusiness, duplicateProps), h(BookingBusiness, { ...duplicateProps, cancellationHours: 48 })],
  }));
} catch (error) { duplicateRejected = error instanceof Error && error.message === 'DuplicateOperation:booking.submit.v1'; }
check(duplicateRejected, 'SameAppInstancesMustNotSilentlyShareOperationIdentity');
console.log('JSX/functions comparison passed: three operations, 24h/48h props, two isolated apps, snapshots, boundaries, failures, exact errors and identical internal trace.');

// Only known test seeds use this assertion; external failures remain Result values.
function valid<T, E>(result: import('koyuki').Result<T, E>): T {
  if (!result.ok) throw new Error('InvalidTestFixture:' + result.error);
  return result.value;
}
