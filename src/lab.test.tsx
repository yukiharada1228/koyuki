import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, Operation, Sequence, Parallel, Runtime } from './core.js';
import { describe, Store, Mailer, validate, confirm, type State, type Candidate } from './reservation.js';
const candidate = (id = 'a'): Candidate => ({ kind: 'candidate', id, seats: 1, version: 0 });

test('pure description does no IO; event loop reaches saved state and sends once on repeat evaluation', async () => {
  const store = new Store(), mailer = new Mailer(), runtime = new Runtime();
  let state: State = { kind: 'raw', id: 'a', seats: 1 };
  const env = { store, mailer, emit: (next: State) => { state = next; } };
  const plan = describe(state, env);
  assert.equal(store.version, 0); assert.equal(mailer.deliveries.length, 0);
  await runtime.execute(plan);
  for (let i = 0; i < 6; i++) await runtime.execute(describe(state, env));
  assert.equal(state.kind, 'saved'); assert.deepEqual(mailer.deliveries, ['a']);
});
test('business rejection produces no save and no email', async () => {
  const store = new Store(), mailer = new Mailer(), runtime = new Runtime();
  let state: State = { kind: 'raw', id: 'a', seats: 2 };
  const env = { store, mailer, emit: (next: State) => { state = next; } };
  for (let i = 0; i < 5; i++) await runtime.execute(describe(state, env));
  assert.equal(state.kind, 'rejected'); assert.equal(store.version, 0); assert.equal(mailer.deliveries.length, 0);
});
test('runtime validates untrusted numeric input', () => {
  for (const seats of [0, -1, NaN, Infinity, 1.5]) assert.equal(validate({ kind: 'raw', id: 'a', seats }).ok, false);
});
test('concurrent decisions can both pass; atomic version check lets only one commit', async () => {
  const store = new Store();
  const a = confirm(store.read({ kind: 'validated', id: 'a', seats: 1 }));
  const b = confirm(store.read({ kind: 'validated', id: 'b', seats: 1 }));
  assert(a.ok && b.ok);
  const results = await Promise.all([a.value, b.value].map(async value => store.commit(value)));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert(results.some(r => !r.ok && r.error === 'Conflict'));
  assert.equal(store.outbox.size, 1);
});
test('replaying same save recovers receipt without decrementing capacity twice', () => {
  const store = new Store(); assert.deepEqual(store.commit(candidate()), store.commit(candidate()));
  assert.equal(store.remaining, 0); assert.equal(store.outbox.size, 1);
});
test('same reservation id with a different payload is rejected', () => {
  const store = new Store(); store.commit(candidate());
  assert.throws(() => store.commit({ ...candidate(), seats: 2 }), /PayloadMismatch/);
});
test('WEAKNESS: crash after email delivery but before completion record causes duplicate delivery', async () => {
  const runtime = new Runtime(), mailer = new Mailer();
  const plan = <Operation id="email:a" payload="a" run={() => mailer.send('a')} />;
  runtime.afterEffect = () => { throw new Error('crash'); };
  await assert.rejects(runtime.execute(plan), /crash/);
  runtime.afterEffect = undefined; await runtime.execute(plan);
  assert.deepEqual(mailer.deliveries, ['a', 'a']);
});
test('provider idempotency prevents the reproduced duplicate on retry', async () => {
  const runtime = new Runtime(), mailer = new Mailer(true);
  const plan = <Operation id="email:a" payload="a" run={() => mailer.send('a')} />;
  runtime.afterEffect = () => { throw new Error('crash'); };
  await assert.rejects(runtime.execute(plan)); runtime.afterEffect = undefined;
  await runtime.execute(plan); assert.deepEqual(mailer.deliveries, ['a']);
});
test('WEAKNESS: same key with changed payload silently skips new work', async () => {
  const runtime = new Runtime(), actual: number[] = [];
  for (const payload of [1, 2]) await runtime.execute(<Operation id="same" payload={payload} run={async () => { actual.push(payload); }} />);
  assert.deepEqual(actual, [1]);
});
test('WEAKNESS: simultaneous execution races past completed-key check', async () => {
  const runtime = new Runtime(), mailer = new Mailer();
  const plan = <Operation id="email:a" payload="a" run={() => mailer.send('a')} />;
  await Promise.all([runtime.execute(plan), runtime.execute(plan)]);
  assert.equal(mailer.deliveries.length, 2);
});
test('sequence stops after failure, before email', async () => {
  const runtime = new Runtime(), mailer = new Mailer();
  const plan = <Sequence>
    <Operation id="save" payload={null} run={async () => { throw new Error('Conflict'); }} />
    <Operation id="email" payload={null} run={() => mailer.send('a')} />
  </Sequence>;
  await assert.rejects(runtime.execute(plan), /Conflict/); assert.equal(mailer.deliveries.length, 0);
});
test('WEAKNESS: parallel starts email even when save fails', async () => {
  const runtime = new Runtime(), mailer = new Mailer();
  const plan = <Parallel>
    <Operation id="save" payload={null} run={async () => { throw new Error('Conflict'); }} />
    <Operation id="email" payload={null} run={() => mailer.send('a')} />
  </Parallel>;
  await assert.rejects(runtime.execute(plan)); assert.equal(mailer.deliveries.length, 1);
});
test('WEAKNESS: remounting a new runtime loses deduplication history', async () => {
  const mailer = new Mailer();
  const plan = <Operation id="email:a" payload="a" run={() => mailer.send('a')} />;
  await new Runtime().execute(plan); await new Runtime().execute(plan);
  assert.equal(mailer.deliveries.length, 2);
});
test('WEAKNESS: commit completion does not guarantee its emitted state was persisted', async () => {
  const runtime = new Runtime(), store = new Store(), mailer = new Mailer();
  const state = candidate(); let emitted: State | undefined;
  await runtime.execute(describe(state, { store, mailer, emit: next => { emitted = next; } }));
  assert.equal(emitted?.kind, 'saved');
  // Simulate losing only the state update, while execution journal survived.
  emitted = undefined;
  await runtime.execute(describe(state, { store, mailer, emit: next => { emitted = next; } }));
  assert.equal(emitted, undefined); assert.equal(store.reservations.size, 1);
});
