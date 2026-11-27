/** @jsx h */
import { bookingId, actorId } from './domain.js';
import { ok, err, type Result, type Execution } from 'koyuki';
import { h, createContext, useContext, defineResource, defineOperation, Operation, createApplicationTemplate } from 'koyuki/experimental';
import { Actor, authenticatedActor } from './app.js';
import { cancelBooking, type Input, type Booking } from './domain.js';
import { collect } from 'koyuki';
async function main() {
  const seed = collect({ one: bookingId('one'), other: bookingId('other'), actor: actorId('alice') });
  if (!seed.ok) return seed;
  type Request = { requestId: string; input: Input };
  type Identity = { key: string; fingerprint: string };
  type Receipt = Identity & { value: Booking };
  type StoreError = 'IdempotencyConflict' | 'ConcurrentChange';
  type CancellationError = Extract<ReturnType<typeof cancelBooking.run>, { ok: false }>['error'];
  // One booking, one process: state and receipt are replaced together, with no await
  // between comparison and replacement. Restart loses both. This is not a DB adapter.
  let state: { booking: Booking; receipt?: Receipt } = { booking: { kind: 'booked', id: seed.value.one, owner: seed.value.actor } };
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
  function useRequestStore() {
    const repository = useContext(Store), actor = useContext(Actor);
    return { repository, identity: (call: Request): Identity => ({ key: call.requestId, fingerprint: JSON.stringify([call.input.id, actor]) }) };
  }
  const requestedBooking = defineResource('requested-booking', () => {
    const repository = useContext(Store);
    return (call: Request) => repository.load(call.input);
  });
  const replayedCancellation = defineOperation('booking.cancel.v1', {
    needs: { booking: requestedBooking, actor: authenticatedActor },
    execute: cancelBooking,
    useSave: () => { const { repository, identity } = useRequestStore(); return (booking: Booking, call: Request) => repository.commit(booking, identity(call)); },
    useReplay: () => { const { repository, identity } = useRequestStore(); return {
      lookup: (call: Request) => repository.lookup(identity(call)),
      resolveAfter: (error: 'Missing' | CancellationError | StoreError) => error === 'AlreadyCancelled' || error === 'ConcurrentChange',
    }; },
  });
  const template = createApplicationTemplate(<Store.Provider value={store}><Operation operation={replayedCancellation} /></Store.Provider>);
  const app = template.scope(children => <Actor.Provider value={seed.value.actor}>{children}</Actor.Provider>);
  const call: Request = { requestId: 'request-1', input: { id: seed.value.one } };
  const first = await app.execute(replayedCancellation, call);
  const second = await app.execute(replayedCancellation, call);
  console.log(first); console.log(second);
  if (!first.ok || first.value.kind !== 'committed' || !second.ok || second.value.kind !== 'replayed' || saves !== 1) throw new Error('ReplayFailed');
  const conflicting = await app.execute(replayedCancellation, { ...call, input: { id: seed.value.other } });
  if (conflicting.ok || conflicting.error !== 'IdempotencyConflict' || saves !== 1) throw new Error('ReplayConflictFailed');
  // Production: persist state + receipts in one transaction with concurrency control.
  return ok(null);
}
console.log(await main());
