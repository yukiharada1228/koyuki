import { manualTagProgram } from './testing/tag-program-manual.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProgram, next, effect, ok, err, type Update, type Result } from './framework/index.js';
import { Repository } from './tags/repository.js';
import { tagProgram, tagView, type TagScreen } from './tags/program.js';
const input = { groupId: 'g', label: 'A', icon: null };
test('one dispatch automatically runs command, handles completion and updates presentation', async () => {
  const repository = new Repository(), program = tagProgram(repository);
  assert.deepEqual(repository.calls, []);
  const session = await program.start(), presentations: string[] = [];
  const unsubscribe = session.subscribe(snapshot => { presentations.push(snapshot.state.kind); });
  const created = await session.dispatch({ type: 'create', input }); assert(created.ok);
  assert.deepEqual(presentations, ['ready', 'running', 'ready']);
  assert.equal(created.value.view.rows[0]?.label, 'A'); assert.equal(created.value.revision, 2);
  assert.deepEqual(repository.calls, ['load-create', 'save-created']);
  const id = created.value.view.rows[0]!.id;
  const updated = await session.dispatch({ type: 'update', input: { ...input, id, expectedVersion: 1, label: 'B' } }); assert(updated.ok);
  assert.equal(updated.value.view.rows[0]?.label, 'B'); assert.equal(updated.value.view.rows[0]?.version, 2);
  unsubscribe();
  assert.deepEqual(session.trace().map(t => t.name), ['@execute', 'create', '@complete', '@execute', 'update', '@complete']);
});
test('business failure becomes a typed state and presentation, dismissal is a pure event', async () => {
  const repository = new Repository(), session = await tagProgram(repository).start();
  const failure = await session.dispatch({ type: 'create', input: { ...input, label: '' } }); assert(failure.ok);
  assert.equal(failure.value.state.kind, 'failed'); assert.equal(failure.value.view.error, 'ValidationError');
  assert.deepEqual(repository.calls, ['load-create']);
  assert((await session.dispatch({ type: 'dismiss' })).ok);
  assert.equal(session.snapshot().state.kind, 'ready'); assert.deepEqual(repository.calls, ['load-create']);
});
test('stale revision and unexpected completion do not change state or execute IO', async () => {
  const repository = new Repository(), session = await tagProgram(repository).start();
  assert.deepEqual(await session.dispatch({ type: 'dismiss' }), err({ kind: 'UnexpectedMessage' }));
  assert.deepEqual(await session.dispatch({ type: 'create', input }, 1), err({ kind: 'StaleRevision' }));
  assert.equal(session.snapshot().revision, 0); assert.deepEqual(repository.calls, []);
});
test('concurrent external events are serialized and stale screens do not overwrite state', async () => {
  const repository = new Repository(), session = await tagProgram(repository).start();
  const results = await Promise.all([session.dispatch({ type: 'create', input }, 0), session.dispatch({ type: 'create', input: { ...input, label: 'B' } }, 0)]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.deepEqual(results[1], err({ kind: 'StaleRevision' }));
  assert.equal(repository.records.size, 1);
});
test('snapshots and pure presentation do not leak mutable internal state', async () => {
  const session = await tagProgram(new Repository()).start(); await session.dispatch({ type: 'create', input });
  const snapshot = session.snapshot();
  if (snapshot.state.kind === 'ready') {
    Reflect.set(snapshot.state.data[0]!.data, 'label', 'corrupted');
  }
  assert.equal(session.snapshot().view.rows[0]?.label, 'A');
  const busy: TagScreen = { kind: 'running', operation: 'create', data: [] };
  assert.deepEqual(tagView(busy).actions, []); assert.equal(tagView(busy).busy, true);
});
test('initial commands execute once and feed automatic events before start resolves', async () => {
  type Msg = { type: 'loaded'; value: number };
  let calls = 0;
  const load = effect('load', async (_: null) => { calls++; return 42; }, (value): Msg => ({ type: 'loaded', value }));
  const program = defineProgram({ init: (): Update<number, Msg> => next(0, load(null)), update: (_: number, msg: Msg) => ok(next<number, Msg>(msg.value)), view: (n: number) => String(n) });
  assert.equal(calls, 0); const session = await program.start(); assert.equal(calls, 1); assert.equal(session.snapshot().view, '42');
});
test('command exception remains visible and does not poison the event queue', async () => {
  type Msg = { type: 'fail' } | { type: 'recover' } | { type: 'done' };
  const bad = effect('broken', async (_: null): Promise<null> => { throw new Error('offline'); }, (): Msg => ({ type: 'done' }));
  const session = await defineProgram({ init: (): Update<number, Msg> => next(0),
    update: (state: number, msg: Msg) => ok(msg.type === 'fail' ? next(state + 1, bad(null)) : next<number, Msg>(0)), view: (n: number) => n }).start();
  await assert.rejects(session.dispatch({ type: 'fail' }), /offline/);
  assert.equal(session.trace().at(-1)?.status, 'error');
  assert((await session.dispatch({ type: 'recover' })).ok); assert.equal(session.snapshot().state, 0);
});
test('rejected reducer leaves state unchanged even if reducer mutates its supplied copy', async () => {
  const session = await defineProgram({ init: (): Update<{ n: number }, { type: 'bad' }> => next({ n: 0 }),
    update: (state: { n: number }): Result<Update<{ n: number }, { type: 'bad' }>, 'Rejected'> => { state.n = 99; return err('Rejected'); }, view: (state: { n: number }) => state.n }).start();
  assert.deepEqual(await session.dispatch({ type: 'bad' }), err('Rejected')); assert.equal(session.snapshot().view, 0);
});

test('init/update/view are independently testable without executing commands', () => {
  const repository = new Repository(), program = manualTagProgram(repository);
  const initial = program.init();
  const result = program.update(initial.state, { type: 'create', input }); assert(result.ok);
  assert.equal(result.value.state.kind, 'creating'); assert.equal(result.value.commands.length, 1);
  assert.equal(program.view(result.value.state).busy, true);
  assert.deepEqual(repository.calls, []);
});
