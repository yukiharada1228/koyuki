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

test('unexpected operation exceptions become a distinct terminal state without retrying or discarding data', async () => {
  let writes = 0;
  const app = defineApplication({ initial: () => 10,
    operations: { change: operation({ run: async (_n: number): Promise<Result<number, { kind: 'Denied' }>> => {
      writes++; throw new Error('response lost after commit');
    } }, (before: number, after) => before + after) },
    view: state => state,
  });
  const session = await app.start();
  const states: string[] = [];
  session.subscribe(snapshot => states.push(snapshot.state.kind));
  const dispatched = await session.dispatch({ type: 'change', input: 1 });
  assert(dispatched.ok);
  assert.deepEqual(session.snapshot().state, { kind: 'crashed', data: 10, operation: 'change', error: { kind: 'UnexpectedException', message: 'response lost after commit' } });
  assert.deepEqual(states, ['ready', 'running', 'crashed']); assert.equal(writes, 1);
  assert.deepEqual(await session.dispatch({ type: 'change', input: 1 }), err({ kind: 'UnexpectedMessage' }));
  assert.equal(writes, 1);
  assert((await session.dispatch({ type: 'dismiss' })).ok);
  assert.deepEqual(session.snapshot().state, { kind: 'ready', data: 10 });
  assert.equal(writes, 1); // dismiss does not retry an operation that may already be committed
  assert.deepEqual(await Reflect.apply(session.dispatch, session, [{ type: '@crash', operation: 'change', error: {} }]), err({ kind: 'UnexpectedMessage' }));
});
test('non-cloneable thrown values and projection failures cannot strand the application in running', async () => {
  for (const failure of ['operation', 'reduce', 'clone', 'error'] as const) {
    const session = await defineApplication({ initial: () => ({ value: 10 }),
      operations: { change: operation({ run: async (_n: number) => {
        if (failure === 'operation') throw () => 'not cloneable';
        if (failure === 'error') return err({ kind: 'MalformedError', callback: () => {} });
        return ok(2);
      } }, (before: { value: number }, after) => {
        if (failure === 'reduce') { before.value = 100; throw new Error('projection failed'); }
        return { value: after, ...(failure === 'clone' ? { callback: () => {} } : {}) };
      }) }, view: state => state.data.value,
    }).start();
    assert((await session.dispatch({ type: 'change', input: 2 })).ok);
    const state = session.snapshot().state;
    assert.equal(state.kind, 'crashed');
    assert.deepEqual(state.data, { value: 10 });
  }
});
test('tag presentation exposes crash recovery instead of offering blocked business operations', () => {
  const view = tagProgram(new Repository()).view({ kind: 'crashed', operation: 'create', data: [], error: { kind: 'UnexpectedException', message: 'offline' } });
  assert.equal(view.busy, false);
  assert.equal(view.error, 'UnexpectedException');
  assert.deepEqual(view.actions, ['dismiss']);
});
