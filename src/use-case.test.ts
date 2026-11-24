import test from 'node:test';
import assert from 'node:assert/strict';
import { defineUseCase, defineRequestTarget, withReplay, ok, err, step, type Result, type Execution, type Receipt, type ReplayBoundary, type ActionReport, type ReplayReport } from './framework/index.js';
type Failure = { kind: 'Invalid' } | { kind: 'Conflict' };
const transition = {
  validate: step('positive', (n: number): Result<number, Failure> => n > 0 ? ok(n) : err({ kind: 'Invalid' })),
  require: [] as const,
  evolve: step('double', (n: number) => ok(n * 2)),
};
test('plain use case preserves target result, detailed trace, request context and failure propagation', async () => {
  const writes: number[] = [];
  const adapter = { operation: 'number', load: async (n: number) => ok(n),
    save: async (n: number, execution: { request: number }) => { writes.push(execution.request); return ok(n); } };
  const old = defineRequestTarget(adapter).on(transition), compact = defineUseCase({ ...adapter, transition });
  assert.deepEqual(await compact.runDetailed(2), await old.runDetailed(2));
  assert.deepEqual(writes, [2, 2]);
  assert.deepEqual(await compact.runDetailed(-1), await old.runDetailed(-1));
  assert.equal(writes.length, 2);
  assert.deepEqual(await compact.run(3), ok(6));
});
test('replay use case exactly matches explicit composition for commit, hit, rejection and recovery', async () => {
  for (const scenario of ['commit', 'hit', 'deny', 'recover', 'missing', 'lookup-error', 'save-replay'] as const) {
    function compose(compact: boolean) {
      let lookups = 0, writes = 0;
      const adapter = { operation: 'number', load: async (n: number) => ok(n),
        save: async (n: number): Promise<Result<Execution<number>, Failure>> => {
          writes++;
          if (scenario === 'recover' || scenario === 'missing') return err({ kind: 'Conflict' });
          return ok({ kind: scenario === 'save-replay' ? 'replayed' : 'committed', value: n });
        } };
      const replay = {
        lookup: (_n: number): Result<Receipt<number>, { kind: 'Unavailable' }> => {
          lookups++;
          return scenario === 'lookup-error' ? err({ kind: 'Unavailable' }) : scenario === 'hit' || (scenario === 'recover' && lookups === 2) ? ok({ kind: 'found', value: 4 }) : ok({ kind: 'missing' });
        }, resolveAfter: (error: Failure) => error.kind === 'Conflict',
      };
      const command = compact ? defineUseCase({ ...adapter, transition, replay }) : withReplay(defineRequestTarget(adapter).on(transition), replay);
      return { command, counts: () => ({ lookups, writes }) };
    }
    const old = compose(false), compact = compose(true), input = scenario === 'deny' ? -1 : 2;
    assert.deepEqual(await compact.command.runDetailed(input), await old.command.runDetailed(input), scenario);
    assert.deepEqual(compact.counts(), old.counts(), scenario);
  }
});
test('plain use case preserves thrown exceptions and isolates concurrent request context', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const saved: number[] = [];
  const command = defineUseCase({ operation: 'concurrent',
    load: async (n: number) => { if (n === 1) await gate; return ok(n); }, transition,
    save: async (_n: number, execution) => { saved.push(execution.request); return ok(execution.request); },
  });
  const first = command.run(1); await command.run(2); release(); await first;
  assert.deepEqual(saved, [2, 1]);
  const throwing = defineUseCase({ operation: 'throw', load: async (n: number) => ok(n), transition,
    save: async (_n: number): Promise<Result<number, never>> => { throw new Error('adapter bug'); },
  });
  await assert.rejects(throwing.runDetailed(1), /adapter bug/);
});
function typeContracts() {
  const adapter = { operation: 'types', load: async (n: number) => ok(n), save: async (n: number) => ok(n) };
  // @ts-expect-error save must accept the transition output
  defineUseCase({ ...adapter, transition, save: async (_s: string) => ok(1) });
  // @ts-expect-error evolve must accept the validated intermediate value
  defineUseCase({ ...adapter, transition: { ...transition, evolve: step('wrong', (s: string) => ok(s)) } });
  // @ts-expect-error require adjacency must remain checked
  defineUseCase({ ...adapter, transition: { ...transition, require: [step('wrong', (s: string) => ok(s))] as const } });
  // @ts-expect-error replay requires an explicit committed/replayed save result
  defineUseCase({ ...adapter, transition, replay: { lookup: (_n: number) => ok({ kind: 'missing' as const }), resolveAfter: () => false } });
  const commit = { ...adapter, save: async (n: number) => ok({ kind: 'committed' as const, value: n }) };
  // @ts-expect-error receipt output must agree with saved business output
  defineUseCase({ ...commit, transition, replay: { lookup: (_n: number) => ok({ kind: 'found' as const, value: 'wrong' }), resolveAfter: () => false } });
  const plain = defineUseCase({ ...adapter, transition });
  const exactPlain: Promise<Result<number, Failure>> = plain.run(1);
  void exactPlain;
  const replayed = defineUseCase({ ...commit, transition, replay: {
    lookup: (input): Result<Receipt<number>, { kind: 'Unavailable' }> => {
      const number: number = input;
      void number;
      // @ts-expect-error lookup input remains inferred as number
      input.notAnInputField;
      return ok({ kind: 'missing' });
    },
    resolveAfter: (error) => {
      // @ts-expect-error recovery callback is contextually typed, not any
      error.notAnErrorField;
      return error.kind === 'Conflict';
    },
  } });
  const exactReplay: Promise<Result<Execution<number>, Failure | { kind: 'Unavailable' } | { kind: 'ReplayInputNotCloneable' }>> = replayed.run(1);
  void exactReplay;
  const inferred = defineUseCase({ operation: 'inferred', load: async (input: number) => ok(input), transition,
    save: async (change: number, execution: { request: number; operation: string }): Promise<Result<Execution<number>, never>> => {
      const n: number = change;
      const request: number = execution.request;
      void n; void request;
      // @ts-expect-error change comes from evolve, not any
      change.notAChangeField;
      // @ts-expect-error request context remains typed
      execution.request.notARequestField;
      return ok({ kind: 'committed' as const, value: change });
    },
    replay: { lookup: input => {
      // @ts-expect-error inline lookup input is inferred from load
      input.notAnInputField;
      return ok({ kind: 'found' as const, value: input });
    }, resolveAfter: error => error.kind === 'Conflict' },
  });
  const exactInferred: Promise<Result<Execution<number>, Failure | { kind: 'ReplayInputNotCloneable' }>> = inferred.run(1);
  void exactInferred;
  const noReplay = defineUseCase({ ...commit, transition, replay: undefined });
  const exactNoReplay: Promise<ActionReport<Execution<number>, Failure>> = noReplay.runDetailed(1);
  void exactNoReplay;
  const optional: { replay?: ReplayBoundary<number, number, Failure, { kind: 'Unavailable' }> } = {};
  const configured = defineUseCase({ ...commit, transition, ...optional });
  const exactOptional: Promise<ActionReport<Execution<number>, Failure> | ReplayReport<number, Failure, { kind: 'Unavailable' }>> = configured.runDetailed(1);
  void exactOptional;
  configured.runDetailed(1).then(report => {
    // @ts-expect-error optional configuration cannot promise a replay report at runtime
    report.attempt;
  });
  // @ts-expect-error caller input remains anchored to load
  plain.run('wrong');
  // @ts-expect-error request metadata cannot be used with the wrong type
  defineUseCase({ ...adapter, transition, save: async (n: number, context: { request: string }) => ok(n) });
}
void typeContracts;
