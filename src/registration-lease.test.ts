import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registration } from './registration/application.js';
import { RegistrationRepository } from './registration/repository.js';
import { renewingEmailWorker } from './registration/lease-delivery.js';
import { ok, err } from './framework/index.js';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-registration-lease-'));
  const path = join(directory, 'db.sqlite'), repository = new RegistrationRepository(path), other = new RegistrationRepository(path);
  t.after(() => { other.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  assert((await registration(repository).request({ id: 'r1', email: 'person@example.com' })).ok);
  return { path, repository, other };
}
function scheduler() {
  let time = 100;
  const pending = new Set<() => void>();
  return {
    everyMs: 3,
    now: () => time,
    wait: (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
      const finish = () => { pending.delete(finish); signal.removeEventListener('abort', finish); resolve(); };
      pending.add(finish); signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    }),
    advance(value: number) { time = value; },
    pulse() { const next = pending.values().next().value; assert(next, 'heartbeat must be scheduled'); next(); },
    pending: () => pending.size,
  };
}

test('renewals fence ownership, cannot revive expiry, and never shorten a live lease', async t => {
  const { repository, other } = await fixture(t);
  const first = await repository.claim(100, 10); assert(first.ok);
  assert.deepEqual(await repository.renew(first.value, Number.MAX_SAFE_INTEGER, 1), err({ kind: 'InvalidLease' }));
  assert.deepEqual(await repository.renew(first.value, 105, 10), ok(undefined));
  assert.deepEqual(await repository.renew(first.value, 106, 1), ok(undefined));
  assert.deepEqual(await other.claim(110, 10), err({ kind: 'EmptyOutbox' }));
  assert.deepEqual(await repository.renew(first.value, 115, 10), err({ kind: 'Conflict' }));
  const second = await other.claim(115, 10); assert(second.ok); assert.notEqual(first.value.claim, second.value.claim);
  assert.deepEqual(await repository.renew(first.value, 116, 10), err({ kind: 'Conflict' }));
  assert.deepEqual(await repository.acknowledge(first.value), err({ kind: 'Conflict' }));
  assert((await other.acknowledge(second.value)).ok);
  assert.deepEqual(await other.renew(second.value, 117, 10), err({ kind: 'Conflict' }));
});

test('heartbeat protects a slow send across the original deadline on another connection', async t => {
  const { repository, other } = await fixture(t), clock = scheduler(), entered = deferred<void>(), sent = deferred<void>();
  let observed = deferred<void>(), renewals = 0;
  const renew = repository.renew.bind(repository);
  repository.renew = async (...args) => { const result = await renew(...args); renewals++; observed.resolve(); return result; };
  const worker = renewingEmailWorker(repository, { send: async () => { entered.resolve(); await sent.promise; } }, clock);
  const running = worker.runDetailed({ now: 100, leaseMs: 10 }); await entered.promise;
  observed = deferred<void>(); clock.advance(105); clock.pulse(); await observed.promise;
  assert.deepEqual(await other.claim(110, 10), err({ kind: 'EmptyOutbox' }));
  observed = deferred<void>(); clock.advance(111); clock.pulse(); await observed.promise;
  assert.deepEqual(await other.claim(115, 10), err({ kind: 'EmptyOutbox' }));
  sent.resolve(); const report = await running;
  assert(report.result.ok); assert.equal(renewals, 4); assert.equal(clock.pending(), 0);
  assert.deepEqual(report.trace.map(row => [row.step, row.status]), [['claim-email', 'ok'], ['send-email', 'ok'], ['ack-email', 'ok']]);
  assert.deepEqual(await other.claim(130, 10), err({ kind: 'EmptyOutbox' }));
});

test('ownership loss aborts cooperative sending and stops before acknowledgement', async t => {
  const { repository, other } = await fixture(t), clock = scheduler(), entered = deferred<void>(), sent = deferred<void>();
  let signal!: AbortSignal;
  const running = renewingEmailWorker(repository, { send: async (_event, current) => { signal = current; entered.resolve(); await sent.promise; } }, clock)
    .runDetailed({ now: 100, leaseMs: 10 });
  await entered.promise;
  const replacement = await other.claim(110, 10); assert(replacement.ok);
  clock.advance(111); clock.pulse(); const report = await running;
  assert.deepEqual(report.result, err({ kind: 'Conflict' })); assert(signal.aborted); assert.equal(clock.pending(), 0);
  assert.deepEqual(report.trace.map(row => row.step), ['claim-email', 'send-email']);
  // A provider may ignore cancellation and reject later; its rejection is still handled.
  sent.reject(Error('late provider rejection')); await Promise.resolve();
  assert((await other.acknowledge(replacement.value)).ok);
});

test('send failure cancels its timer, leaves the event pending, and preserves the event id on retry', async t => {
  const { repository, other } = await fixture(t), clock = scheduler();
  let id = '';
  const report = await renewingEmailWorker(repository, { send: async event => { id = event.id; throw Error('offline'); } }, clock)
    .runDetailed({ now: 100, leaseMs: 10 });
  assert.deepEqual(report.result, err({ kind: 'DeliveryUnavailable' })); assert.equal(clock.pending(), 0);
  const retry = await other.claim(110, 10); assert(retry.ok); assert.equal(retry.value.event.id, id);
});

test('completion after expiry is rejected even before a scheduled heartbeat runs', async t => {
  const { repository, other } = await fixture(t), clock = scheduler();
  const report = await renewingEmailWorker(repository, { send: async () => { clock.advance(110); } }, clock)
    .runDetailed({ now: 100, leaseMs: 10 });
  assert.deepEqual(report.result, err({ kind: 'Conflict' })); assert.equal(clock.pending(), 0);
  assert.equal(report.trace.at(-1)?.step, 'send-email'); assert((await other.claim(110, 10)).ok);
});

test('heartbeat infrastructure failure aborts sending and does not mark the event delivered', async t => {
  const { repository, other } = await fixture(t), clock = scheduler(), entered = deferred<void>(), sent = deferred<void>();
  let signal!: AbortSignal, unavailable = false;
  const running = renewingEmailWorker(repository, { send: async (_event, current) => { signal = current; entered.resolve(); await sent.promise; } },
    { ...clock, now: () => { if (unavailable) throw Error('clock offline'); return clock.now(); } }).runDetailed({ now: 100, leaseMs: 10 });
  await entered.promise; unavailable = true; clock.pulse();
  const report = await running; assert.deepEqual(report.result, err({ kind: 'HeartbeatUnavailable' }));
  assert(signal.aborted); assert.equal(clock.pending(), 0); sent.resolve();
  assert((await other.claim(110, 10)).ok);
});

test('a delayed tick cannot begin sending after its claim has already expired', async t => {
  const { repository, other } = await fixture(t); let sends = 0;
  const report = await renewingEmailWorker(repository, { send: async () => { sends++; } }, { everyMs: 3, now: () => 200 })
    .runDetailed({ now: 100, leaseMs: 10 });
  assert.deepEqual(report.result, err({ kind: 'Conflict' })); assert.equal(sends, 0);
  assert((await other.claim(200, 10)).ok);
});

test('a rejected SQLite renewal stops delivery without acknowledging or hiding the storage failure', async t => {
  const { path, repository, other } = await fixture(t), clock = scheduler(), entered = deferred<void>(), sent = deferred<void>();
  const db = new DatabaseSync(path); t.after(() => db.close());
  let signal!: AbortSignal;
  const running = renewingEmailWorker(repository, { send: async (_event, current) => { signal = current; entered.resolve(); await sent.promise; } }, clock)
    .runDetailed({ now: 100, leaseMs: 10 });
  await entered.promise;
  db.exec("CREATE TRIGGER reject_renewal BEFORE UPDATE OF lease_until ON email_outbox BEGIN SELECT RAISE(ABORT,'renewal unavailable'); END");
  clock.advance(105); clock.pulse(); const report = await running;
  assert.deepEqual(report.result, err({ kind: 'StorageUnavailable' })); assert(signal.aborted); assert.equal(clock.pending(), 0);
  assert.equal(db.prepare('SELECT delivered FROM email_outbox').get()?.delivered, 0);
  sent.resolve(); db.exec('DROP TRIGGER reject_renewal');
  assert((await other.claim(110, 10)).ok);
});

test('send completion cannot hide a pending renewal rejection during timer shutdown', async t => {
  const { repository, other } = await fixture(t), clock = scheduler();
  const sending = deferred<void>(), sent = deferred<void>(), renewing = deferred<void>(), renewal = deferred<void>(), stopped = deferred<void>();
  let calls = 0;
  const renew = repository.renew.bind(repository);
  repository.renew = async (...args) => {
    if (++calls === 2) { renewing.resolve(); await renewal.promise; }
    return renew(...args);
  };
  const running = renewingEmailWorker(repository, { send: async () => { sending.resolve(); await sent.promise; } }, {
    ...clock, wait: (ms, signal) => {
      signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      return clock.wait(ms, signal);
    },
  }).runDetailed({ now: 100, leaseMs: 10 });
  await sending.promise; clock.advance(105); clock.pulse(); await renewing.promise;
  sent.resolve(); await stopped.promise; renewal.reject(Error('pending renewal failed'));
  const report = await running;
  assert.deepEqual(report.result, err({ kind: 'HeartbeatUnavailable' })); assert.equal(calls, 2);
  assert.equal(report.trace.at(-1)?.step, 'send-email'); assert((await other.claim(110, 10)).ok);
});

test('invalid timing cannot claim an event, and the default Web timer stops after immediate delivery', async t => {
  const { repository, other } = await fixture(t);
  assert.throws(() => renewingEmailWorker(repository, { send: async () => {} }, { everyMs: 0, now: () => 100 }), /InvalidHeartbeatInterval/);
  assert.throws(() => renewingEmailWorker(repository, { send: async () => {} }, { everyMs: Number.MAX_SAFE_INTEGER, now: () => 100 }), /InvalidHeartbeatInterval/);
  const invalid = renewingEmailWorker(repository, { send: async () => assert.fail('invalid interval') }, { everyMs: 10, now: () => 100 });
  assert.deepEqual(await invalid.run({ now: 100, leaseMs: 10 }), err({ kind: 'InvalidLease' }));
  class Clock { readonly everyMs = 100; time = 100; now() { return this.time; } }
  const worker = renewingEmailWorker(repository, { send: async () => {} }, new Clock());
  assert((await worker.run({ now: 100, leaseMs: 1000 })).ok);
  assert.deepEqual(await other.claim(2000, 10), err({ kind: 'EmptyOutbox' }));
  assert((await registration(repository).request({ id: 'r2', email: 'second@example.com' })).ok);
  let stopped = false;
  const aborting = renewingEmailWorker(repository, { send: async () => {} }, {
    everyMs: 3, now: () => 100,
    wait: (_ms, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { stopped = true; reject(Error('wait aborted')); }, { once: true });
    }),
  });
  assert((await aborting.run({ now: 100, leaseMs: 10 })).ok); assert(stopped);
});
