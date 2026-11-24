import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operation, ok, err, type Result } from './framework/index.js';
import { Repository, type CreateLoadError, type SaveError } from './tags/repository.js';
import type { PersistedTag, ValidationError, DuplicateLabel, QuotaError } from './tags/domain.js';
import { tagProgram, type TagMessage, type TagScreen } from './tags/program.js';
import { manualTagProgram } from './testing/tag-program-manual.js';
const input = { groupId: 'g', label: 'A', icon: null };
test('generated lifecycle agrees with manual implementation for success and failure scenarios', async () => {
  const a = new Repository(), b = new Repository();
  const before = await manualTagProgram(a).start(), after = await tagProgram(b).start();
  const messages: TagMessage[] = [
    { type: 'create', input },
    { type: 'update', input: { ...input, id: 'tag-1', expectedVersion: 1, label: 'B' } },
    { type: 'create', input: { ...input, label: ' B ' } },
    { type: 'dismiss' },
    { type: 'create', input: { ...input, label: '' } },
    { type: 'dismiss' },
    { type: 'update', input: { ...input, id: 'tag-1', expectedVersion: 1 } },
    { type: 'dismiss' },
  ];
  for (const message of messages) {
    const left = await before.dispatch(message), right = await after.dispatch(message);
    assert.equal(left.ok, right.ok);
    assert.deepEqual(before.snapshot().view, after.snapshot().view);
    assert.deepEqual(before.snapshot().state.tags, after.snapshot().state.data);
    assert.equal(before.snapshot().revision, after.snapshot().revision);
  }
  assert.deepEqual(a.calls, b.calls); assert.deepEqual(a.records, b.records);
});
test('pure initial state and business projection do no IO; completion events are not public', async () => {
  const repository = new Repository(), program = tagProgram(repository);
  assert.deepEqual(program.initial(), { kind: 'ready', data: [] }); assert.deepEqual(repository.calls, []);
  const session = await program.start();
  const result = await Reflect.apply(session.dispatch, session, [{ type: '@complete', operation: 'create', result: ok({}) }]);
  assert.deepEqual(result, err({ kind: 'UnexpectedMessage' })); assert.deepEqual(repository.calls, []);
  assert.equal(session.snapshot().revision, 0);
});
test('generated lifecycle is domain independent and keeps failures correlated with operations', async () => {
  let additions = 0;
  const app = defineApplication({
    initial: () => 0,
    operations: {
      add: operation({ run: async (n: number): Promise<Result<number, 'Negative'>> => { additions++; return n < 0 ? err('Negative') : ok(n); } }, (state: number, result) => state + result),
      replace: operation({ run: async (text: string): Promise<Result<number, 'InvalidNumber'>> => Number.isFinite(Number(text)) ? ok(Number(text)) : err('InvalidNumber') }, (_state: number, result) => result),
    },
    view: state => String(state.data),
  });
  const session = await app.start();
  assert((await session.dispatch({ type: 'add', input: 3 })).ok); assert.equal(session.snapshot().view, '3');
  await session.dispatch({ type: 'add', input: -1 });
  const failed = session.snapshot().state;
  assert.equal(failed.kind, 'failed');
  if (failed.kind === 'failed' && failed.operation === 'add') { const error: 'Negative' = failed.error; assert.equal(error, 'Negative'); }
  assert.deepEqual(await session.dispatch({ type: 'add', input: 2 }), err({ kind: 'UnexpectedMessage' }));
  assert.equal(additions, 2);
  await session.dispatch({ type: 'dismiss' }); await session.dispatch({ type: 'replace', input: '10' });
  assert.equal(session.snapshot().state.data, 10);
  if (false) {
    // @ts-expect-error operation name determines the input type
    await session.dispatch({ type: 'replace', input: 10 });
    // @ts-expect-error no handwritten completion event is accepted
    await session.dispatch({ type: '@complete', operation: 'add', result: ok(1) });
  }
});
test('different failed operations retain different errors and do not reduce business state', async () => {
  let reduces = 0;
  const app = defineApplication({ initial: () => ({ total: 7 }), operations: {
    change: operation({ run: async (_: string): Promise<Result<number, { kind: 'Rejected'; reason: string }>> => err({ kind: 'Rejected', reason: 'policy' }) }, (state: { total: number }, value) => { reduces++; return { total: state.total + value }; }),
  }, view: state => state.data.total });
  const session = await app.start(); await session.dispatch({ type: 'change', input: 'x' });
  assert.equal(reduces, 0); assert.equal(session.snapshot().view, 7);
  const state = session.snapshot().state; assert(state.kind === 'failed'); assert.equal(state.error.reason, 'policy');
});
test('reserved lifecycle names cannot overwrite framework behavior', () => {
  assert.throws(() => defineApplication({ initial: () => 0, operations: {
    dismiss: operation({ run: async (n: number) => ok(n) }, (_: number, value) => value),
  }, view: state => state.data }), /ReservedOperationName/);
});
function typeChecks(state: TagScreen) {
  if (state.kind === 'failed' && state.operation === 'create') {
    const precise: CreateLoadError | SaveError | ValidationError | DuplicateLabel | QuotaError = state.error;
    void precise;
    // @ts-expect-error create failures cannot be treated as update-only target mismatch
    const wrong: { kind: 'TargetMismatch' } = state.error;
    void wrong;
  }
  // @ts-expect-error running state requires its operation identity
  const missingOperation: TagScreen = { kind: 'running', data: [] };
  // @ts-expect-error business projection accepts only the typed persisted result
  operation({ run: async (_: number) => ok(1) }, (state: readonly PersistedTag[], output: string) => state);
  void missingOperation;
}
void typeChecks;
