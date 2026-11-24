import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, withReplay, replayOperation, defineApplication, type Result, type Execution, type Receipt } from './framework/index.js';
type Error = { kind: 'Conflict' } | { kind: 'Denied' } | { kind: 'UnknownCommit' };
type LookupError = { kind: 'StorageUnavailable' } | { kind: 'IdempotencyConflict' };
const resolveAfter = (error: Error) => error.kind === 'Conflict' || error.kind === 'UnknownCommit';
const missing = (): Result<Receipt<number>, LookupError> => ok({ kind: 'missing' });
const found = (value: number): Result<Receipt<number>, LookupError> => ok({ kind: 'found', value });
const committed = (value: number): Result<Execution<number>, Error> => ok({ kind: 'committed', value });
test('missing receipt executes once and preserves committed metadata', async () => {
  let calls = 0;
  const command = withReplay({ run: async (x: number) => { calls++; return committed(x + 1); } }, { lookup: missing, resolveAfter });
  assert.deepEqual(await command.run(1), ok({ kind: 'committed', value: 2 })); assert.equal(calls, 1);
});
test('receipt hit skips load, validation and commit', async () => {
  const command = withReplay({ run: async (_: number) => { assert.fail('must not execute'); return committed(0); } }, { lookup: () => found(3), resolveAfter });
  assert.deepEqual(await command.run(1), ok({ kind: 'replayed', value: 3 }));
});
test('atomic commit replay metadata is preserved even after lookup miss', async () => {
  const command = withReplay({ run: async (_: number): Promise<Result<Execution<number>, Error>> => ok({ kind: 'replayed', value: 9 }) }, { lookup: missing, resolveAfter });
  assert.deepEqual(await command.run(1), ok({ kind: 'replayed', value: 9 }));
});
test('only explicitly classified failures trigger one post-failure lookup', async () => {
  for (const kind of ['Conflict', 'UnknownCommit', 'Denied'] as const) {
    let calls = 0, executions = 0;
    const command = withReplay({ run: async (_: number): Promise<Result<Execution<number>, Error>> => { executions++; return err({ kind }); } },
      { lookup: () => ++calls === 1 ? missing() : found(5), resolveAfter });
    assert.deepEqual(await command.run(1), kind === 'Denied' ? err({ kind }) : ok({ kind: 'replayed', value: 5 }));
    assert.equal(calls, kind === 'Denied' ? 1 : 2); assert.equal(executions, 1);
  }
});
test('absent race winner preserves the original error without retrying', async () => {
  let executions = 0;
  const command = withReplay({ run: async (_: number): Promise<Result<Execution<number>, Error>> => { executions++; return err({ kind: 'Conflict' }); } }, { lookup: missing, resolveAfter });
  assert.deepEqual(await command.run(1), err({ kind: 'Conflict' })); assert.equal(executions, 1);
});
test('receipt infrastructure and identity errors propagate before execution', async () => {
  for (const kind of ['StorageUnavailable', 'IdempotencyConflict'] as const) {
    const command = withReplay({ run: async (_: number) => { assert.fail('must not execute'); return committed(0); } },
      { lookup: (): Result<Receipt<number>, LookupError> => err({ kind }), resolveAfter });
    assert.deepEqual(await command.run(1), err({ kind }));
  }
});
test('failure during race lookup is not replaced by the original conflict', async () => {
  let calls = 0;
  const command = withReplay({ run: async (_: number): Promise<Result<Execution<number>, Error>> => err({ kind: 'UnknownCommit' }) },
    { lookup: (): Result<Receipt<number>, LookupError> => ++calls === 1 ? missing() : err({ kind: 'StorageUnavailable' }), resolveAfter });
  assert.deepEqual(await command.run(1), err({ kind: 'StorageUnavailable' }));
});
test('nested caller input is detached before async lookup starts', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const command = withReplay({ run: async (x: { nested: { value: number } }) => committed(x.nested.value) },
    { lookup: async (_: { nested: { value: number } }) => { await gate; return missing(); }, resolveAfter });
  const input = { nested: { value: 1 } }, result = command.run(input);
  input.nested.value = 99; release(); assert.deepEqual(await result, ok({ kind: 'committed', value: 1 }));
});
test('non-cloneable input fails before lookup or execution', async () => {
  const command = withReplay({ run: async (_: unknown) => { assert.fail('must not execute'); return committed(0); } },
    { lookup: () => { assert.fail('must not look up'); return missing(); }, resolveAfter });
  assert.deepEqual(await command.run({ fn() {} }), err({ kind: 'ReplayInputNotCloneable' }));
});
test('unexpected adapter exceptions remain exceptions, not automatic retries', async () => {
  let calls = 0;
  const command = withReplay({ run: async (_: number) => { calls++; throw new globalThis.Error('adapter bug'); return committed(0); } }, { lookup: missing, resolveAfter });
  await assert.rejects(command.run(1), /adapter bug/); assert.equal(calls, 1);
});
test('replayOperation never reduces historical replay into current application data', async () => {
  let reduceCalls = 0;
  const command = { run: async (kind: 'committed' | 'replayed'): Promise<Result<Execution<number>, never>> => ok({ kind, value: kind === 'committed' ? 2 : 1 }) };
  const app = defineApplication({ initial: () => 0,
    operations: { update: replayOperation(command, (_: number, n) => { reduceCalls++; return n; }) }, view: state => state.data });
  const session = await app.start();
  await session.dispatch({ type: 'update', input: 'committed' }); assert.equal(session.snapshot().view, 2);
  await session.dispatch({ type: 'update', input: 'replayed' }); assert.equal(session.snapshot().view, 2); assert.equal(reduceCalls, 1);
});
function typeContracts() {
  // @ts-expect-error commit adapter must explicitly distinguish new commit from replay
  withReplay({ run: async (_: number) => ok(1) }, { lookup: missing, resolveAfter });
  const command = { run: async (_: number) => committed(1) };
  // @ts-expect-error receipt type must match command's business output
  withReplay(command, { lookup: () => ok({ kind: 'found', value: 'wrong' }), resolveAfter });
}
void typeContracts;
