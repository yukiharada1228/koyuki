/** @jsx h */
import { ok, err, workflow, type Result } from 'koyuki';
import { h, createContext, useContext, defineOperation, Operation, createApplication } from 'koyuki/experimental';
type Booking = { kind: 'booked'; id: string; owner: string } | { kind: 'cancelled'; id: string; owner: string };
type Input = { id: string };
const Actor = createContext<string>();
const Repository = createContext<{ load(input: Input): Promise<Result<Booking, 'Missing'>>; save(value: Booking): Promise<Result<Booking, never>> }>();
const cancel = workflow('authorize-cancel', (value: { booking: Booking; actor: string }): Result<Extract<Booking, { kind: 'booked' }>, 'Forbidden' | 'AlreadyCancelled'> => {
  if (value.booking.owner !== value.actor) return err('Forbidden');
  return value.booking.kind === 'booked' ? ok(value.booking) : err('AlreadyCancelled');
}).then('cancel', value => ok({ ...value, kind: 'cancelled' as const }));
const cancellation = defineOperation('booking.cancel.v1', () => {
  const repository = useContext(Repository), actor = useContext(Actor);
  return {
    load: async (input: Input) => {
      const result = await repository.load(input);
      return result.ok ? ok({ booking: result.value, actor }) : result;
    },
    execute: cancel,
    save: (value: Booking) => repository.save(value),
  };
});
let saved = 0;
const repo = { load: async (input: Input): Promise<Result<Booking, 'Missing'>> => input.id === 'missing' ? err('Missing') : ok({ kind: 'booked', id: input.id, owner: 'owner' }), save: async (value: Booking) => { saved++; return ok(value); } };
function mount(actor: string) { return createApplication(<Repository.Provider value={repo}><Actor.Provider value={actor}><Operation operation={cancellation} /></Actor.Provider></Repository.Provider>); }
const [success, forbidden] = await Promise.all([mount('owner').executeDetailed(cancellation, { id: 'one' }), mount('other').execute(cancellation, { id: 'two' })]);
if (!success.result.ok || success.result.value.kind !== 'cancelled' || !success.trace.some(row => row.step === 'cancel')) throw new Error('CancellationFailed');
if (forbidden.ok || forbidden.error !== 'Forbidden' || saved !== 1) throw new Error('ActorOrSaveIsolationFailed');
const missing = await mount('owner').execute(cancellation, { id: 'missing' });
if (missing.ok || missing.error !== 'Missing' || saved !== 1) throw new Error('LoadFailureNotStopped');
if (false) {
  // @ts-expect-error Requests retain their inferred input type.
  void mount('owner').execute(cancellation, { id: 1 });
}
console.log('booking cancellation: success, denied, missing, trace and actor isolation passed');
