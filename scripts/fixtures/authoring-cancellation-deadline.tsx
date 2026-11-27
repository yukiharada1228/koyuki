/** @jsx h */
import { ok, err, workflow, type Result } from 'koyuki';
import { h, createContext, useContext, defineOperation, Operation, createApplication } from 'koyuki/experimental';
type Booking = { kind: 'booked'; id: string; owner: string; startsAt: number } | { kind: 'cancelled'; id: string; owner: string; startsAt: number };
type Input = { id: string };
const Actor = createContext<string>();
const Clock = createContext<() => number>();
const Repository = createContext<{ load(input: Input): Promise<Result<Booking, 'Missing'>>; save(value: Booking): Promise<Result<Booking, never>> }>();
const day = 24 * 60 * 60 * 1000;
const cancel = workflow('authorize-cancel', (value: { booking: Booking; actor: string; now: number }): Result<{ booking: Extract<Booking, { kind: 'booked' }>; now: number }, 'Forbidden' | 'AlreadyCancelled'> => {
  if (value.booking.owner !== value.actor) return err('Forbidden');
  return value.booking.kind === 'booked' ? ok({ booking: value.booking, now: value.now }) : err('AlreadyCancelled');
}).then('check-cancellation-deadline', (value): Result<Extract<Booking, { kind: 'booked' }>, 'CancellationClosed' | 'InvalidTime'> => {
  if (!Number.isSafeInteger(value.now) || !Number.isSafeInteger(value.booking.startsAt)) return err('InvalidTime');
  return value.booking.startsAt - value.now >= day ? ok(value.booking) : err('CancellationClosed');
}).then('cancel', value => ok({ ...value, kind: 'cancelled' as const }));
const cancellation = defineOperation('booking.cancel.v1', () => {
  const repository = useContext(Repository), actor = useContext(Actor), clock = useContext(Clock);
  return {
    load: async (input: Input) => {
      const result = await repository.load(input);
      return result.ok ? ok({ booking: result.value, actor, now: clock() }) : result;
    },
    execute: cancel,
    save: (value: Booking) => repository.save(value),
  };
});
const startsAt = Date.UTC(2030, 0, 3);
let now = startsAt - day, saved = 0, clockReads = 0;
const repo = {
  load: async (input: Input): Promise<Result<Booking, 'Missing'>> => input.id === 'missing' ? err('Missing') : ok({ kind: input.id === 'cancelled' ? 'cancelled' : 'booked', id: input.id, owner: 'owner', startsAt: input.id === 'invalid' ? NaN : startsAt }),
  save: async (value: Booking) => { saved++; return ok(value); },
};
const clock = () => { clockReads++; return now; };
function mount(actor: string) { return createApplication(<Repository.Provider value={repo}><Actor.Provider value={actor}><Clock.Provider value={clock}><Operation operation={cancellation} /></Clock.Provider></Actor.Provider></Repository.Provider>); }
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
const app = mount('owner');
check(clockReads === 0 && saved === 0, 'MountMustNotReadClockOrSave');
for (const offset of [1, 0, -1]) {
  now = startsAt - day - offset;
  const before = saved;
  const report = await app.executeDetailed(cancellation, { id: 'one' });
  if (offset >= 0) {
    check(report.result.ok && report.result.value.kind === 'cancelled', 'DeadlineBoundaryMustAllow');
    check(saved === before + 1 && report.trace.some(row => row.step === 'check-cancellation-deadline' && row.status === 'ok'), 'SuccessTraceAndSave');
  } else {
    check(!report.result.ok && report.result.error === 'CancellationClosed', 'DeadlineBoundaryMustReject');
    check(saved === before && !report.trace.some(row => row.step === 'cancel'), 'DeadlineFailureMustStop');
  }
}
for (const [id, actor, time, error] of [
  ['one', 'owner', startsAt, 'CancellationClosed'],
  ['one', 'owner', startsAt + 1, 'CancellationClosed'],
  ['invalid', 'owner', startsAt - day, 'InvalidTime'],
  ['one', 'owner', NaN, 'InvalidTime'],
  ['cancelled', 'owner', startsAt - day, 'AlreadyCancelled'],
  ['one', 'other', startsAt - day, 'Forbidden'],
  ['missing', 'owner', startsAt - day, 'Missing'],
] as const) {
  now = time;
  const before = saved;
  const result = await mount(actor).execute(cancellation, { id });
  check(!result.ok && result.error === error && saved === before, `FailureMustNotSave:${error}`);
}
now = startsAt - day;
const before = saved;
const [owner, other] = await Promise.all([mount('owner').execute(cancellation, { id: 'one' }), mount('other').execute(cancellation, { id: 'two' })]);
check(owner.ok && !other.ok && other.error === 'Forbidden' && saved === before + 1, 'ConcurrentActorIsolation');
const immutable = Object.freeze({ booking: Object.freeze({ kind: 'booked' as const, id: 'pure', owner: 'owner', startsAt }), actor: 'owner', now });
const pure = cancel.run(immutable);
check(pure.ok && pure.value.kind === 'cancelled' && immutable.booking.kind === 'booked', 'PureTransitionMustNotMutate');
if (false) {
  // @ts-expect-error The caller cannot supply a trusted clock in the request.
  void app.execute(cancellation, { id: 'one', now: 0 });
  // @ts-expect-error The deadline error must propagate into the inferred result.
  const noDeadline: Promise<Result<Booking, 'Missing' | 'Forbidden' | 'AlreadyCancelled'>> = app.execute(cancellation, { id: 'one' });
  void noDeadline;
}
console.log('deadline change: boundary ±1ms, repeated clock reads, failures, pure transition and actor isolation passed');
