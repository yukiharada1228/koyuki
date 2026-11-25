import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaveApplication } from './application.js';
import { SqliteLeave } from './repository.js';

// Exercise the public Application, not just the underlying HTTP commands.
test('declared leave application owns lifecycle, failure, replay and view updates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-application-'));
  const repository = new SqliteLeave(join(dir, 'db.sqlite'));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const seeded = repository.seed('owner', 5); assert(seeded.ok);
  const initial = repository.read('owner'); assert(initial.ok);
  const actor = { id: 'owner', role: 'employee', active: true } as const;
  const session = await leaveApplication(repository, actor, initial.value).start();
  const states: string[] = [];
  const stop = session.subscribe(snapshot => states.push(snapshot.state.kind));
  t.after(stop);
  const first = { type: 'submit', input: { requestId: 'first', input: {
    employee: 'owner', leaveId: 'first', expectedVersion: 1, days: 3,
  } } } as const;
  assert((await session.dispatch(first)).ok);
  assert.deepEqual(states, ['ready', 'running', 'ready']);
  assert.deepEqual(session.snapshot().view.balance, { granted: 5, reserved: 3, used: 0, available: 2 });
  const failure = await session.dispatch({ type: 'submit', input: { requestId: 'over', input: {
    ...first.input.input, leaveId: 'over', expectedVersion: 2, days: 3,
  } } });
  assert(failure.ok); assert.equal(failure.value.state.kind, 'failed');
  assert.equal(failure.value.view.error, 'InsufficientDays'); assert.equal(failure.value.view.account.version, 2);
  assert((await session.dispatch({ type: 'dismiss' })).ok);
  assert((await session.dispatch({ type: 'withdraw', input: { requestId: 'withdraw', input: {
    employee: 'owner', leaveId: 'first', expectedVersion: 2,
  } } })).ok);
  assert.equal(session.snapshot().view.account.version, 3);
  assert.equal(session.snapshot().view.balance.available, 5);
  // Historical success must not rewind the current application projection.
  assert((await session.dispatch(first)).ok);
  assert.equal(session.snapshot().view.account.version, 3);
  const stored = repository.read('owner'); assert(stored.ok);
  assert.deepEqual(session.snapshot().view.account, stored.value);
  assert.deepEqual(states, ['ready', 'running', 'ready', 'running', 'failed', 'ready', 'running', 'ready', 'running', 'ready']);
  if (false) {
    // @ts-expect-error submit requires days, inferred through group and Application
    await session.dispatch({ type: 'submit', input: { requestId: 'bad', input: { employee: 'owner', leaveId: 'x', expectedVersion: 3 } } });
    // @ts-expect-error runtime completion is never a public business event
    await session.dispatch({ type: '@complete', input: null });
  }
});

test('queued business requests preserve dispatched payloads and reject stale screens before IO', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-application-queue-'));
  const repository = new SqliteLeave(join(dir, 'db.sqlite'));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  assert(repository.seed('owner', 5).ok);
  const initial = repository.read('owner'); assert(initial.ok);
  let release!: () => void, entered!: () => void, loads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const load = repository.load.bind(repository);
  repository.load = async (input, actor) => {
    loads++;
    if (loads === 1) { entered(); await gate; }
    return load(input, actor);
  };
  const session = await leaveApplication(repository, { id: 'owner', role: 'employee', active: true }, initial.value).start();
  const first = session.dispatch({ type: 'submit', input: { requestId: 'one', input: {
    employee: 'owner', leaveId: 'one', expectedVersion: 1, days: 1,
  } } }, 0);
  await started;
  const queued = { type: 'submit' as const, input: { requestId: 'two', input: {
    employee: 'owner', leaveId: 'two', expectedVersion: 2, days: 2,
  } } };
  const second = session.dispatch(queued);
  const stale = session.dispatch({ type: 'submit', input: { requestId: 'stale', input: {
    employee: 'owner', leaveId: 'stale', expectedVersion: 3, days: 1,
  } } }, 0);
  queued.input.requestId = 'changed'; queued.input.input.days = 99;
  release(); assert((await first).ok); assert((await second).ok);
  assert.deepEqual(await stale, { ok: false, error: { kind: 'StaleRevision' } });
  assert.equal(loads, 2);
  assert.equal(session.snapshot().view.account.version, 3);
  assert.equal(session.snapshot().view.balance.reserved, 3);
  assert.equal(session.snapshot().view.account.leaves[1]?.days, 2);
});
