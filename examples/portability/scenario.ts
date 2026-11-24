import { defineUseCase, step, ok, err, type Result, type Receipt, type Execution, type RequestExecution } from 'koyuki';
type State = Readonly<{ value: number; version: number }>;
type Call = Readonly<{ requestId: string; amount: number; expectedVersion: number }>;
type Loaded = Readonly<{ current: State; input: Call }>;
type Change = Readonly<{ expectedVersion: number; next: State }>;
type Failure = { kind: 'Conflict' } | { kind: 'UnknownCommit' } | { kind: 'IdempotencyConflict' };
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
/** New state for every invocation: no cross-request memory or persistent-storage claim. */
export async function runScenario() {
  const nodeGlobals = ['process', 'Buffer', 'require'].filter(key => key in globalThis);
  let current: State = { value: 0, version: 1 }, writes = 0, loseResponse = false;
  const receipts = new Map<string, { fingerprint: string; value: State }>();
  const fingerprint = (call: Call) => JSON.stringify([call.amount, call.expectedVersion]);
  const lookup = (call: Call): Result<Receipt<State>, Failure> => {
    const receipt = receipts.get(call.requestId);
    return !receipt ? ok({ kind: 'missing' }) : receipt.fingerprint === fingerprint(call)
      ? ok({ kind: 'found', value: receipt.value }) : err({ kind: 'IdempotencyConflict' });
  };
  const operation = defineUseCase({
    operation: 'portable.add.v1',
    load: async (input: Call): Promise<Result<Loaded, Failure>> => current.version === input.expectedVersion ? ok({ current, input }) : err({ kind: 'Conflict' }),
    transition: {
      validate: step('validate-amount', (loaded: Loaded): Result<Loaded, { kind: 'InvalidAmount' }> =>
        Number.isSafeInteger(loaded.input.amount) && loaded.input.amount > 0 ? ok(loaded) : err({ kind: 'InvalidAmount' })),
      require: [] as const,
      evolve: step('add', (loaded: Loaded): Result<Change, never> => ok({ expectedVersion: loaded.current.version,
        next: { value: loaded.current.value + loaded.input.amount, version: loaded.current.version + 1 } })),
    },
    save: async (change: Change, execution: RequestExecution<Call>): Promise<Result<Execution<State>, Failure>> => {
      const prior = lookup(execution.request); if (!prior.ok) return prior;
      if (prior.value.kind === 'found') return ok({ kind: 'replayed', value: prior.value.value });
      if (current.version !== change.expectedVersion) return err({ kind: 'Conflict' });
      current = Object.freeze(change.next); writes++;
      receipts.set(execution.request.requestId, { fingerprint: fingerprint(execution.request), value: current });
      return loseResponse ? err({ kind: 'UnknownCommit' }) : ok({ kind: 'committed', value: current });
    },
    replay: { lookup, resolveAfter: error => error.kind === 'Conflict' || error.kind === 'UnknownCommit' },
  });
  const call = { requestId: 'first', amount: 2, expectedVersion: 1 };
  const normal = await operation.run(call);
  check(normal.ok && normal.value.kind === 'committed', 'ordinary execution failed');
  const replay = await operation.runDetailed(call);
  check(replay.result.ok && replay.result.value.kind === 'replayed' && replay.attempt === null, 'replay executed domain code');
  const rejected = await operation.runDetailed({ requestId: 'bad', amount: -1, expectedVersion: 2 });
  check(!rejected.result.ok && rejected.result.error.kind === 'InvalidAmount', 'validation did not stop');
  check(rejected.attempt?.trace?.map(t => t.step).join(',') === 'portable.add.v1:load,validate-amount', 'fabricated trace');
  loseResponse = true;
  const recovered = await operation.runDetailed({ requestId: 'second', amount: 3, expectedVersion: 2 });
  check(recovered.result.ok && recovered.result.value.kind === 'replayed', 'unknown commit not resolved');
  check(recovered.attempt && !recovered.attempt.result.ok && recovered.attempt.result.error.kind === 'UnknownCommit', 'original failure lost');
  check(recovered.trace.at(-1)?.kind === 'lookup', 'resolution lookup missing');
  check(writes === 2 && current.value === 5, 'duplicate write');
  return { ok: true, normal: normal.value.kind, replay: replay.result.value.kind, rejected: rejected.result.error.kind,
    recovered: recovered.result.value.kind, writes, current, nodeGlobals, recoveryTrace: recovered.trace };
}
