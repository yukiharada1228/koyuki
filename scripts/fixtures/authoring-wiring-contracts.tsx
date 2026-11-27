/** @jsx h */
import { ok, err, type Result } from 'koyuki';
import { h, Fragment, createApplication, defineResource, defineOperation, defineEvent, emit, Operation, On, defineView, projection, defineQuery, Query, refreshQuery } from 'koyuki/experimental';
const current = defineResource('current', () => async (input: { id: string }): Promise<Result<number, 'Missing'>> => input.id ? ok(1) : err('Missing'));
const actor = defineResource('actor', () => () => ok('host'));
const changed = defineEvent<number>('changed');
export const producer = defineOperation('producer', {
  needs: { current, actor }, execute: (values: { current: number; actor: string }) => ok(values.current),
  useSave: () => async (value: number): Promise<Result<number, 'Offline'>> => ok(value), emits: [emit(changed)],
});
const payload = defineResource('payload', () => (value: number) => ok(value));
const receiver = defineOperation('receiver', { needs: { payload }, execute: ({ payload }: { payload: number }) => ok(payload), useSave: () => async (value: number) => ok(value) });
const snapshotQuery = defineQuery('snapshot-query', { needs: current, select: (value: number): Result<number, 'TooLarge'> => value > 100 ? err('TooLarge') : ok(value) });
export const app = createApplication(<Fragment><Operation operation={producer} /><On event={changed} operation={receiver} /><Query query={snapshotQuery} /></Fragment>);
const report = await app.executeDetailed(producer, { id: 'one' });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<typeof report.result, Result<number, 'Missing' | 'Offline'>> = true; void exact;
const id: string | undefined = report.publications[0]?.id; void id;
if (false) {
  // @ts-expect-error Every resource input must be satisfied.
  void app.execute(producer, {});
  // @ts-expect-error Host actor is not caller input.
  void app.execute(producer, { id: 'one', actor: 'admin' });
  // @ts-expect-error Consumer input must accept the event payload.
  void <On event={defineEvent<string>('string')} operation={receiver} />;
  // @ts-expect-error Resource values must satisfy business requirements.
  defineOperation('bad-context', { needs: { current }, execute: (values: { current: string }) => ok(values), useSave: () => async (value: { current: string }) => ok(value) });
  // @ts-expect-error Saved value must accept the decision's success value.
  defineOperation('bad-save', { needs: { current }, execute: (values: { current: number }) => ok(values.current), useSave: () => async (value: string) => ok(value) });
}

export const screen = defineView({
  initial: () => 0,
  operations: { change: projection(producer, (_state: number, output) => output) },
  queries: { snapshot: refreshQuery(snapshotQuery, { input: (_state: number) => ({ id: 'one' }), on: [changed], reduce: (_state: number, value) => value }) },
  view: state => ({ value: state.data, busy: state.kind === 'running' || state.refreshing, error: state.kind === 'failed' ? state.error : null, query: state.queries.snapshot }),
});
export const session = await app.start(screen);
const snapshot = session.snapshot();
const exactError: Equal<typeof snapshot.view.error, 'Missing' | 'Offline' | null> = true; void exactError;
if (false) {
  // @ts-expect-error Session events retain the underlying operation input.
  void session.dispatch({ type: 'change', input: {} });
  // @ts-expect-error Projection cannot consume a different success type.
  projection(producer, (_state: number, value: string) => value.length);
}

if (false) {
  // @ts-expect-error Handwritten bindings must also accept the true success type.
  void app.start({ initial: () => 0, operations: { bad: { operation: producer, reduce: (_state: number, value: string) => value.length } }, view: state => state.data });
}

const queryError: Equal<Extract<typeof snapshot.view.query, { kind: 'failed' }>['error'], 'Missing' | 'TooLarge'> = true; void queryError;
if (false) {
  // @ts-expect-error Read-only queries have no save stage.
  defineQuery('bad-query', { needs: current, select: (value: number) => ok(value), useSave: () => async (value: number) => ok(value) });
  // @ts-expect-error Query input must satisfy its resources.
  refreshQuery(snapshotQuery, { input: (_state: number) => ({}), on: [changed], reduce: (_state: number, value) => value });
}
function selectedSpecContract(choose: boolean) {
  const tenant = defineResource('tenant', () => (input: { tenant: string }) => ok(input.tenant));
  const needs = choose ? current : { tenant };
  const selected = defineOperation('selected-public-spec', { needs, execute: (_value: unknown) => ok(1), useSave: () => async (value: number) => ok(value) });
  const mounted = createApplication(<Operation operation={selected} />);
  void mounted.execute(selected, { id: 'one', tenant: 'two' });
  // @ts-expect-error Every candidate resource requirement must be satisfied.
  void mounted.execute(selected, { id: 'one' });
  // @ts-expect-error The direct resource candidate still requires id.
  void mounted.execute(selected, { tenant: 'two' });
}
void selectedSpecContract;

// Domain identifiers survive the installed package's Resource/operation inference.
import { bookingId, actorId, type BookingId, type ActorId } from './domain.js';
const bookingIdentity = bookingId('one'), actorIdentity = actorId('one');
const bookingValidation: Equal<typeof bookingIdentity, Result<BookingId, 'InvalidBookingId'>> = true;
const actorValidation: Equal<typeof actorIdentity, Result<ActorId, 'InvalidActorId'>> = true; void bookingValidation; void actorValidation;
if (!bookingIdentity.ok || !actorIdentity.ok) throw new Error('InvalidContractFixture');
const bookingValue = bookingIdentity.value, actorValue = actorIdentity.value;
const identified = defineResource('identified', () => (input: { id: BookingId }) => ok(input.id));
const bookingChanged = defineEvent<BookingId>('typed-booking.changed.v1');
export const typedBooking = defineOperation('typed-booking.v1', { needs: identified, execute: (id: BookingId) => ok(id), useSave: () => async (id: BookingId) => ok(id), emits: [emit(bookingChanged)] });
const bookingPayload = defineResource('booking-payload', () => (id: BookingId) => ok(id));
const bookingReceiver = defineOperation('booking-receiver.v1', { needs: bookingPayload, execute: (id: BookingId) => ok(id), useSave: () => async (id: BookingId) => ok(id) });
export const typedApp = createApplication(<Fragment><Operation operation={typedBooking} /><On event={bookingChanged} operation={bookingReceiver} /></Fragment>);
const typedResult = await typedApp.execute(typedBooking, { id: bookingValue });
const typedExact: Equal<typeof typedResult, Result<BookingId, never>> = true; void typedExact;
const actorInput = defineResource('actor-input', () => (id: ActorId) => ok(id));
const actorOperation = defineOperation('actor.v1', { needs: actorInput, execute: (id: ActorId) => ok(id), useSave: () => async (id: ActorId) => ok(id) });
if (false) {
  // @ts-expect-error A validation Result is not the ID inside it.
  void typedApp.execute(typedBooking, { id: bookingIdentity });
  // @ts-expect-error Different domain IDs cannot be exchanged.
  void typedApp.execute(typedBooking, { id: actorValue });
  // @ts-expect-error Raw request strings must be validated.
  void typedApp.execute(typedBooking, { id: 'one' });
  // @ts-expect-error Event payloads retain their domain brand during connection.
  void <On event={bookingChanged} operation={actorOperation} />;
}

type Pending = Readonly<{ kind: 'pending'; id: string }>;
type Done = Readonly<{ kind: 'done'; id: string }>;
type State = Pending | Done;
const savedSource = defineResource('save-source', () => (input: { id: string }) => ok(input.id));
const decideDone = (id: string): Result<Done, 'Denied'> => ok({ kind: 'done', id });
const preserving = async <T extends State>(value: T): Promise<Result<T, 'Offline'>> => ok(value);
const wrapped = async <T extends State>(value: T): Promise<Result<{ readonly kind: 'committed'; readonly value: T }, 'Offline'>> => ok({ kind: 'committed', value });
const broad = async (value: State): Promise<Result<State, 'Offline'>> => ok({ kind: 'pending', id: value.id });
export const preservedSave = defineOperation('save-preserved', { needs: savedSource, execute: decideDone, useSave: () => preserving });
export const wrappedSave = defineOperation('save-wrapped', { needs: savedSource, execute: decideDone, useSave: () => wrapped });
export const broadSave = defineOperation('save-broad', { needs: savedSource, execute: decideDone, useSave: () => broad });
export const transformedSave = defineOperation('save-transformed', { needs: savedSource, execute: decideDone, useSave: () => async (value: Done): Promise<Result<{ saved: string }, 'Offline'>> => ok({ saved: value.id }) });
export const saveApp = createApplication(<Fragment><Operation operation={preservedSave} /><Operation operation={wrappedSave} /><Operation operation={broadSave} /><Operation operation={transformedSave} /></Fragment>);
async function savedContract() {
  const direct = await saveApp.execute(preservedSave, { id: 'one' });
  const envelope = await saveApp.execute(wrappedSave, { id: 'one' });
  const wide = await saveApp.execute(broadSave, { id: 'one' });
  const transformed = await saveApp.execute(transformedSave, { id: 'one' });
  const a: Equal<typeof direct, Result<Done, 'Denied' | 'Offline'>> = true;
  const b: Equal<typeof envelope, Result<{ readonly kind: 'committed'; readonly value: Done }, 'Denied' | 'Offline'>> = true;
  const c: Equal<typeof wide, Result<State, 'Denied' | 'Offline'>> = true;
  const d: Equal<typeof transformed, Result<{ saved: string }, 'Denied' | 'Offline'>> = true;
  void a; void b; void c; void d;
  if (false) {
    // @ts-expect-error A broad save can return Pending, so its output must not narrow to Done.
    const unsound: Result<Done, 'Denied' | 'Offline'> = wide;
    void unsound;
    // @ts-expect-error Saving cannot accept an incompatible decision value.
    defineOperation('wrong-save-state', { needs: savedSource, execute: decideDone, useSave: () => async (value: Pending) => ok(value) });
  }
  return { direct, envelope, wide, transformed };
}

void savedContract;

// A new real operation reuses the same API, preserving a larger request and exact errors.
import { rescheduleBooking, bookingRescheduled } from './rescheduling.js';
import type { Confirmed } from './domain.js';
import type { RescheduleRequest } from './rescheduling-request.js';
import type { Execution, ReplayInputError } from 'koyuki';
type ReschedulingHandler = ReturnType<typeof rescheduleBooking.use>;
type ReschedulingInput = Parameters<ReschedulingHandler['run']>[0];
type ReschedulingResult = Awaited<ReturnType<ReschedulingHandler['run']>>;
const reschedulingInputExact: Equal<ReschedulingInput, RescheduleRequest> = true;
const reschedulingOutputExact: Equal<Extract<ReschedulingResult, { ok: true }>['value'], Execution<Confirmed>> = true;
const reschedulingErrorExact: Equal<Extract<ReschedulingResult, { ok: false }>['error'], 'Missing' | 'StorageFailed' | 'ConcurrentChange' | 'InvalidState' | 'Forbidden' | 'BookingMismatch' | 'InvalidTime' | 'ReschedulingClosed' | 'Unchanged' | 'IdempotencyConflict' | 'InvalidBookingInput' | 'InvalidBookingId' | 'InvalidRescheduleInput' | 'InvalidRequestId' | ReplayInputError> = true;
void reschedulingInputExact; void reschedulingOutputExact; void reschedulingErrorExact;
if (false) {
  // @ts-expect-error A rescheduling event cannot feed an ActorId operation.
  void <On event={bookingRescheduled} operation={actorOperation} />;
  // @ts-expect-error Replayable operations require a stable request ID.
  void typedApp.execute(rescheduleBooking, { id: bookingValue, startsAt: 2_000_000_000_000 });
  // @ts-expect-error The new operation requires a replacement time.
  void typedApp.execute(rescheduleBooking, { id: bookingValue });
  // @ts-expect-error An actor ID cannot identify the booking being rescheduled.
  void typedApp.execute(rescheduleBooking, { requestId: 'change-one', id: actorValue, startsAt: 2_000_000_000_000 });
}

// Request scopes preserve the operation's existing input/output contract.
import { createApplicationTemplate, Guard } from 'koyuki/experimental';
export const scopedBookingTemplate = createApplicationTemplate(
  <Guard useCheck={() => () => ok(undefined)}><Operation operation={typedBooking} /></Guard>
);
