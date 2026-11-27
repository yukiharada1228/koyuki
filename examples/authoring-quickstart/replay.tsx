/** @jsx h */
import { ok, err, type Result, type Execution } from 'koyuki';
import { h, createContext, useContext, defineOperation, Operation, createApplication } from 'koyuki/experimental';
import { Actor } from './app.js';
import { cancelBooking, type Input, type Booking } from './domain.js';
type Request = { requestId: string; input: Input };
type Identity = { key: string; fingerprint: string };
type Receipt = Identity & { value: Booking };
type StoreError = 'IdempotencyConflict' | 'ConcurrentChange';
type CancellationError = Extract<ReturnType<typeof cancelBooking.run>, { ok: false }>['error'];
// One booking, one process: state and receipt are replaced together, with no await
// between comparison and replacement. Restart loses both. This is not a DB adapter.
let state: { booking: Booking; receipt?: Receipt } = { booking: { kind: 'booked', id: 'one', owner: 'alice' } };
let saves = 0;
const store = {
  async load(input: Input): Promise<Result<Booking, 'Missing'>> { return input.id === state.booking.id ? ok({ ...state.booking }) : err('Missing'); },
  lookup(identity: Identity): Result<{ kind: 'missing' } | { kind: 'found'; value: Booking }, 'IdempotencyConflict'> {
    const receipt = state.receipt;
    return !receipt || receipt.key !== identity.key ? ok({ kind: 'missing' }) : receipt.fingerprint === identity.fingerprint
      ? ok({ kind: 'found', value: receipt.value }) : err('IdempotencyConflict');
  },
  async commit(booking: Booking, identity: Identity): Promise<Result<Execution<Booking>, StoreError>> {
    const previous = store.lookup(identity);
    if (!previous.ok) return previous;
    if (previous.value.kind === 'found') return ok({ kind: 'replayed', value: previous.value.value });
    if (state.booking.kind !== 'booked' || booking.id !== state.booking.id) return err('ConcurrentChange');
    state = { booking: { ...booking }, receipt: { ...identity, value: { ...booking } } };
    saves++; return ok({ kind: 'committed', value: booking });
  },
};
const Store = createContext<typeof store>();
const replayedCancellation = defineOperation('booking.cancel.v1', () => {
  const repository = useContext(Store), actor = useContext(Actor);
  const identity = (call: Request): Identity => ({ key: call.requestId, fingerprint: JSON.stringify([call.input.id, actor]) });
  return {
    load: async (call: Request) => {
      const result = await repository.load(call.input);
      return result.ok ? ok({ booking: result.value, actor }) : result;
    },
    execute: cancelBooking,
    save: (booking: Booking, call: Request) => repository.commit(booking, identity(call)),
    replay: { lookup: (call: Request) => repository.lookup(identity(call)), resolveAfter: (error: 'Missing' | CancellationError | StoreError) => error === 'AlreadyCancelled' || error === 'ConcurrentChange' },
  };
});
const app = createApplication(<Store.Provider value={store}><Actor.Provider value="alice"><Operation operation={replayedCancellation} /></Actor.Provider></Store.Provider>);
const call: Request = { requestId: 'request-1', input: { id: 'one' } };
const first = await app.execute(replayedCancellation, call);
const second = await app.execute(replayedCancellation, call);
console.log(first); console.log(second);
if (!first.ok || first.value.kind !== 'committed' || !second.ok || second.value.kind !== 'replayed' || saves !== 1) throw new Error('ReplayFailed');
const conflicting = await app.execute(replayedCancellation, { ...call, input: { id: 'other' } });
if (conflicting.ok || conflicting.error !== 'IdempotencyConflict' || saves !== 1) throw new Error('ReplayConflictFailed');
// Production: persist state + receipts in one transaction with concurrency control.
