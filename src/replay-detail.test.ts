import test from 'node:test';
import assert from 'node:assert/strict';
import { withReplay, defineRequestTarget, step, ok, err, type Execution, type Result, type Receipt, type ReplayTrace } from './framework/index.js';
type Failure = { kind: 'Denied' } | { kind: 'Conflict' };
const missing = (): Result<Receipt<number>, { kind: 'Unavailable' }> => ok({ kind: 'missing' });
const found = (): Result<Receipt<number>, { kind: 'Unavailable' }> => ok({ kind: 'found', value: 7 });
const snapshot = { kind: 'snapshot', status: 'ok' } as const;
const before = { kind: 'lookup', phase: 'before', status: 'missing' } as const;

test('detailed target records actual load, validation, evolution and save; receipt hit invents none', async () => {
  let calls = 0, cached = false;
  const target = defineRequestTarget({ operation: 'number.v1', load: async (input: number) => { calls++; return ok(input); }, save: async (n: number) => ok({ kind: 'committed' as const, value: n }) }).on({
    validate: step('positive', (n: number): Result<number, Failure> => n > 0 ? ok(n) : err({ kind: 'Denied' })),
    require: [] as const, evolve: step('double', (n: number) => ok(n * 2)),
  });
  const command = withReplay(target, { lookup: () => cached ? found() : missing(), resolveAfter: () => false });
  const first = await command.runDetailed(2);
  assert.deepEqual(first.trace, [snapshot, before, { kind: 'command', status: 'committed' }]);
  assert.deepEqual(first.result, ok({ kind: 'committed', value: 4 }));
  assert.deepEqual(first.attempt?.trace?.map(t => t.step), ['number.v1:load', 'positive', 'double', 'number.v1']);
  assert.ok(first.attempt?.plan);
  cached = true;
  const replay = await command.runDetailed(2);
  assert.deepEqual(replay.trace, [snapshot, { kind: 'lookup', phase: 'before', status: 'found' }]);
  assert.equal(replay.attempt, null); assert.equal(calls, 1);
});
test('domain rejection records short circuit and no recovery when not classified', async () => {
  const target = defineRequestTarget({ operation: 'deny', load: async (n: number) => ok(n), save: async (_n: number) => { assert.fail('save must not run'); return ok({ kind: 'committed' as const, value: 0 }); } }).on({
    validate: step('deny', (_n: number): Result<number, Failure> => err({ kind: 'Denied' })), require: [] as const,
    evolve: step('unreachable', (n: number) => ok(n)),
  });
  const detail = await withReplay(target, { lookup: missing, resolveAfter: () => false }).runDetailed(1);
  assert.deepEqual(detail.result, err({ kind: 'Denied' }));
  assert.deepEqual(detail.trace, [snapshot, before, { kind: 'command', status: 'error' }, { kind: 'resolution', status: 'skip' }]);
  assert.deepEqual(detail.attempt?.trace?.map(t => t.step), ['deny:load', 'deny']);
  assert.equal(detail.attempt?.plan, null);
});
test('recovery retains original failure, final lookup status and final result', async () => {
  for (const status of ['found', 'missing', 'error'] as const) {
    let lookups = 0, executions = 0;
    const command = withReplay({ run: async (_n: number): Promise<Result<Execution<number>, Failure>> => { executions++; return err({ kind: 'Conflict' }); } }, {
      lookup: () => ++lookups === 1 ? missing() : status === 'found' ? found() : status === 'missing' ? missing() : err({ kind: 'Unavailable' as const }),
      resolveAfter: () => true,
    });
    const detail = await command.runDetailed(1);
    assert.deepEqual(detail.trace, [snapshot, before, { kind: 'command', status: 'error' }, { kind: 'resolution', status: 'lookup' }, { kind: 'lookup', phase: 'after-error', status }]);
    assert.deepEqual(detail.attempt?.result, err({ kind: 'Conflict' }));
    assert.equal(detail.attempt?.trace, null); // run-only command; no fabricated domain trace
    assert.deepEqual(detail.result, status === 'found' ? ok({ kind: 'replayed', value: 7 }) : status === 'missing' ? err({ kind: 'Conflict' }) : err({ kind: 'Unavailable' }));
    assert.equal(executions, 1); assert.equal(lookups, 2);
  }
});
test('snapshot and initial lookup failures produce no command attempt', async () => {
  const command = withReplay({ run: async (_input: unknown) => { assert.fail('must not execute'); return ok({ kind: 'committed' as const, value: 0 }); } }, {
    lookup: (): Result<Receipt<number>, { kind: 'Unavailable' }> => err({ kind: 'Unavailable' }), resolveAfter: () => false,
  });
  const invalid = await command.runDetailed(() => 1);
  assert.deepEqual(invalid.trace, [{ kind: 'snapshot', status: 'error' }]); assert.equal(invalid.attempt, null);
  const unavailable = await command.runDetailed(1);
  assert.deepEqual(unavailable.trace, [snapshot, { kind: 'lookup', phase: 'before', status: 'error' }]); assert.equal(unavailable.attempt, null);
});
test('run preserves original command route; detailed uses captured instrumentation only once', async () => {
  let plain = 0, detailed = 0;
  const source = {
    run: async (_n: number) => { plain++; return ok({ kind: 'committed' as const, value: 1 }); },
    runDetailed: async (_n: number) => { detailed++; return { result: ok({ kind: 'replayed' as const, value: 2 }), trace: [], plan: null }; },
  };
  // Both paths legitimately return different commit metadata in this adapter stub.
  const command = withReplay(source, { lookup: missing, resolveAfter: () => false });
  source.runDetailed = async () => { throw new Error('replaced'); };
  assert.deepEqual(await command.run(1), ok({ kind: 'committed', value: 1 }));
  const detail = await command.runDetailed(1);
  assert.deepEqual(detail.trace, [snapshot, before, { kind: 'command', status: 'replayed' }]);
  assert.deepEqual(detail.attempt?.trace, []);
  assert.equal(plain, 1); assert.equal(detailed, 1);
});
test('simultaneous reports are isolated and unexpected exceptions still reject', async () => {
  const command = withReplay({ run: async (n: number) => ok({ kind: 'committed' as const, value: n }) }, { lookup: (n: number) => n === 1 ? found() : missing(), resolveAfter: () => false });
  const [hit, commit] = await Promise.all([command.runDetailed(1), command.runDetailed(2)]);
  assert.equal(hit.trace.length, 2); assert.equal(commit.trace.length, 3); assert.notEqual(hit.trace, commit.trace);
  const throwing = withReplay({ run: async (_n: number) => ok({ kind: 'committed' as const, value: 0 }), runDetailed: async (_n: number) => { throw new Error('unexpected'); } }, { lookup: missing, resolveAfter: () => false });
  await assert.rejects(throwing.runDetailed(1), /unexpected/);
});
function typeContracts() {
  const trace: ReplayTrace = { kind: 'lookup', phase: 'before', status: 'found' };
  void trace;
  const command = { run: async (_n: number) => ok({ kind: 'committed' as const, value: 1 }),
    runDetailed: async (_n: number) => ({ result: ok({ kind: 'committed' as const, value: 'wrong' }), trace: [], plan: null }) };
  // @ts-expect-error detailed output must agree with the existing run output
  withReplay(command, { lookup: missing, resolveAfter: () => false });
}
void typeContracts;
