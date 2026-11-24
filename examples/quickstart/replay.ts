import assert from 'node:assert/strict';
import { defineUseCase, step, ok, err, type Result, type Execution, type Receipt, type RequestExecution } from 'koyuki';
type State = Readonly<{ value: number; version: number }>;
type Call = Readonly<{ requestId: string; expectedVersion: number; amount: number }>;
type Change = Readonly<{ expectedVersion: number; next: State }>;
type StorageError = { kind: 'Conflict' } | { kind: 'IdempotencyConflict' } | { kind: 'UnknownCommit' };
let current: State = { value: 0, version: 1 }, writes = 0, loseResponse = false;
const receipts = new Map<string, { fingerprint: string; value: State }>();
const fingerprint = (call: Call) => JSON.stringify([call.expectedVersion, call.amount]);
function lookup(call: Call): Result<Receipt<State>, StorageError> {
  const cached = receipts.get(call.requestId);
  if (!cached) return ok({ kind: 'missing' });
  return cached.fingerprint === fingerprint(call) ? ok({ kind: 'found', value: cached.value }) : err({ kind: 'IdempotencyConflict' });
}
const add = defineUseCase({
  operation: 'counter.add.v1',
  load: async (call: Call): Promise<Result<{ state: State; input: Call }, StorageError>> =>
    current.version === call.expectedVersion ? ok({ state: current, input: call }) : err({ kind: 'Conflict' }),
  transition: {
    validate: step('positive-amount', (loaded: { state: State; input: Call }): Result<typeof loaded, { kind: 'InvalidAmount' }> =>
      Number.isSafeInteger(loaded.input.amount) && loaded.input.amount > 0 && Number.isSafeInteger(loaded.state.value + loaded.input.amount)
        ? ok(loaded) : err({ kind: 'InvalidAmount' })),
    require: [] as const,
    evolve: step('add', (loaded: { state: State; input: Call }): Result<Change, never> => ok({
      expectedVersion: loaded.state.version,
      next: { value: loaded.state.value + loaded.input.amount, version: loaded.state.version + 1 },
    })),
  },
  // No await between updates: single-process in-memory demonstration only.
  // A real adapter must commit state and receipt in one DB transaction.
  save: async (change: Change, execution: RequestExecution<Call>): Promise<Result<Execution<State>, StorageError>> => {
    const cached = lookup(execution.request); if (!cached.ok) return cached;
    if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
    if (current.version !== change.expectedVersion) return err({ kind: 'Conflict' });
    current = Object.freeze(change.next); writes++;
    receipts.set(execution.request.requestId, { fingerprint: fingerprint(execution.request), value: current });
    return loseResponse ? err({ kind: 'UnknownCommit' }) : ok({ kind: 'committed', value: current });
  },
  replay: { lookup, resolveAfter: error => error.kind === 'Conflict' || error.kind === 'UnknownCommit' },
});
const call = { requestId: 'first', expectedVersion: 1, amount: 2 };
const normal = await add.runDetailed(call); assert(normal.result.ok && normal.result.value.kind === 'committed');
assert.deepEqual(normal.attempt?.trace?.map(x => x.step), ['counter.add.v1:load', 'positive-amount', 'add', 'counter.add.v1']);
const replay = await add.runDetailed(call); assert(replay.result.ok && replay.result.value.kind === 'replayed');
assert.equal(replay.attempt, null); assert.equal(writes, 1);
const denied = await add.runDetailed({ requestId: 'bad', expectedVersion: 2, amount: -1 });
assert.deepEqual(denied.result, err({ kind: 'InvalidAmount' })); assert.equal(writes, 1);
assert.deepEqual(denied.attempt?.trace?.map(x => x.step), ['counter.add.v1:load', 'positive-amount']);
loseResponse = true;
const recovered = await add.runDetailed({ requestId: 'second', expectedVersion: 2, amount: 3 });
assert(recovered.result.ok && recovered.result.value.kind === 'replayed');
assert.deepEqual(recovered.attempt?.result, err({ kind: 'UnknownCommit' }));
assert.deepEqual(recovered.trace.at(-1), { kind: 'lookup', phase: 'after-error', status: 'found' });
assert.equal(writes, 2); assert.deepEqual(current, { value: 5, version: 3 });
console.log(JSON.stringify({ normal: normal.result.value.kind, replay: replay.result.value.kind, recovered: recovered.result.value.kind, writes }));
