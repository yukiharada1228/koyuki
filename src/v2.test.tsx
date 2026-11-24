/** @jsx h2 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, RuntimeV2, ReservationProcess, Save, Notify, h2, decide } from './v2.js';
import { Mailer, type Validated } from './reservation.js';
function fixture(t: { after: (fn: () => void) => void }, idempotent = true) {
  const dir = mkdtempSync(join(tmpdir(), 'business-react-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, 'snapshot.json')), mailer = new Mailer(idempotent);
  return { store, mailer, runtime: new RuntimeV2(store, mailer) };
}
const raw = (id = 'a', seats = 1) => ({ kind: 'raw' as const, id, seats });
test('v2 declaration is serializable, deterministic and produces no IO', t => {
  const { store, mailer } = fixture(t);
  const before = store.read();
  assert.deepEqual(ReservationProcess({ state: raw() }), ReservationProcess({ state: raw() }));
  assert.deepEqual(JSON.parse(JSON.stringify(ReservationProcess({ state: raw() }))), { kind: 'advance' });
  assert.deepEqual(store.read(), before); assert.equal(mailer.deliveries.length, 0);
});
test('v2 success and repeated render/run do not repeat notification', async t => {
  const { runtime, mailer, store } = fixture(t);
  await runtime.start(raw()); assert.equal((await runtime.run('a')).kind, 'notified');
  await runtime.run('a'); assert.equal(mailer.deliveries.length, 1);
  assert.equal(store.read().remaining, 0); assert.equal(store.read().outbox.a?.sent, true);
});
test('v2 invalid input and full capacity are business rejections', async t => {
  const { runtime, mailer, store } = fixture(t);
  for (const [id, seats] of [['invalid', 0], ['full', 2]] as const) {
    await runtime.start(raw(id, seats)); assert.equal((await runtime.run(id)).kind, 'rejected');
  }
  assert.equal(mailer.deliveries.length, 0); assert.equal(store.read().version, 0);
});
test('v2 storage failure before save commit leaves neither reservation, state, journal nor outbox partially saved', async t => {
  const { runtime, store } = fixture(t); await runtime.start(raw());
  for (let i = 0; i < 3; i++) await runtime.tick('a');
  const before = store.read();
  runtime.beforeCommit = kind => { if (kind === 'save') throw new Error('InjectedWriteFailure'); };
  await assert.rejects(runtime.tick('a'), /InjectedWriteFailure/); assert.deepEqual(store.read(), before);
  runtime.beforeCommit = undefined; assert.equal((await runtime.run('a')).kind, 'notified');
});
test('v2 recreating runtime/store after save recovers saved state and sends pending notification', async t => {
  const { runtime, store, mailer } = fixture(t); await runtime.start(raw());
  for (let i = 0; i < 4; i++) await runtime.tick('a');
  assert.equal(store.read().records.a?.state.kind, 'saved');
  const resumed = new RuntimeV2(new FileStore(store.path), mailer);
  assert.equal((await resumed.run('a')).kind, 'notified');
  await new RuntimeV2(new FileStore(store.path), mailer).run('a');
  assert.equal(mailer.deliveries.length, 1);
});
test('v2 two runtimes sharing store serialize concurrent execution', async t => {
  const { runtime, store, mailer } = fixture(t); await runtime.start(raw());
  const second = new RuntimeV2(new FileStore(store.path), mailer);
  await Promise.all([runtime.run('a'), second.run('a')]); assert.equal(mailer.deliveries.length, 1);
});
test('v2 same command id with different payload fails explicitly', async t => {
  const { runtime } = fixture(t); await runtime.start(raw());
  await assert.rejects(runtime.start(raw('a', 2)), /PayloadMismatch/);
});
test('v2 stale revision and modified declaration fail instead of silently skipping', async t => {
  const { runtime } = fixture(t); await runtime.start(raw()); await runtime.tick('a', 0);
  await assert.rejects(runtime.tick('a', 0), /StaleRevision/);
  await assert.rejects(runtime.tick('a', 1, { kind: 'done' }), /DeclarationMismatch/);
});
test('v2 two valid decisions on same snapshot yield one saved and one explicit conflict; only winner emails', async t => {
  const { runtime, store, mailer } = fixture(t);
  await runtime.start(raw('a')); await runtime.start(raw('b'));
  for (const id of ['a', 'b']) for (let i = 0; i < 3; i++) await runtime.tick(id);
  assert.equal(store.read().records.a?.state.kind, 'candidate');
  assert.equal(store.read().records.b?.state.kind, 'candidate');
  const result = await Promise.all([runtime.run('a'), runtime.run('b')]);
  assert.deepEqual(result.map(s => s.kind).sort(), ['conflict', 'notified']);
  assert.equal(mailer.deliveries.length, 1); assert.equal(store.read().remaining, 0);
});
test('v2 external-success crash recovers without duplicate ONLY with provider idempotency', async t => {
  const { runtime, store, mailer } = fixture(t); await runtime.start(raw());
  runtime.afterExternal = () => { throw new Error('CrashAfterSend'); };
  await assert.rejects(runtime.run('a'), /CrashAfterSend/);
  assert.equal(store.read().records.a?.state.kind, 'saved');
  assert.equal(store.read().outbox.a?.sent, false);
  await new RuntimeV2(new FileStore(store.path), mailer).run('a');
  assert.equal(mailer.deliveries.length, 1); assert.equal(store.read().outbox.a?.sent, true);
});
test('v2 REMAINING LIMIT: non-idempotent provider still delivers twice after crash', async t => {
  const { runtime, store, mailer } = fixture(t, false); await runtime.start(raw());
  runtime.afterExternal = () => { throw new Error('CrashAfterSend'); };
  await assert.rejects(runtime.run('a'));
  await new RuntimeV2(new FileStore(store.path), mailer).run('a');
  assert.equal(mailer.deliveries.length, 2);
});
test('v2 invalid event is a defect rather than a business rejection', () => {
  assert.throws(() => decide(raw(), { type: 'notified' }), /InvalidEvent/);
});
// Type regression assertions are checked by tsc, independently of runtime tests.
function typeAssertions(validated: Validated) {
  // @ts-expect-error A save requires a Candidate, not a Validated state.
  const badSave = <Save input={validated} />;
  // @ts-expect-error Notification requires a saved receipt.
  const badNotify = <Notify input={{ kind: 'candidate', id: 'a', seats: 1, version: 0 }} />;
  return [badSave, badNotify];
}
void typeAssertions;

test('v2 provider failure retains pending notification and allows explicit retry', async t => {
  const { store } = fixture(t);
  class FailingOnce extends Mailer {
    fail = true;
    override async send(id: string): Promise<void> {
      if (this.fail) throw new Error('ProviderUnavailable');
      return super.send(id);
    }
  }
  const mailer = new FailingOnce(true), runtime = new RuntimeV2(store, mailer);
  await runtime.start(raw()); await assert.rejects(runtime.run('a'), /ProviderUnavailable/);
  assert.equal(store.read().records.a?.state.kind, 'saved');
  assert.equal(store.read().outbox.a?.sent, false);
  mailer.fail = false; assert.equal((await runtime.run('a')).kind, 'notified');
});
test('v2 NEW LIMIT: slow external IO holds the store-wide lock and blocks unrelated reservations', async t => {
  const { store } = fixture(t);
  let entered!: () => void, release!: () => void;
  const sending = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  class SlowMailer extends Mailer {
    override async send(id: string): Promise<void> { entered(); await gate; return super.send(id); }
  }
  const runtime = new RuntimeV2(store, new SlowMailer(true));
  await runtime.start(raw()); const running = runtime.run('a'); await sending;
  let unrelatedStarted = false;
  const unrelated = runtime.start(raw('b')).then(() => { unrelatedStarted = true; });
  try {
    await new Promise<void>(r => setImmediate(r));
    assert.equal(unrelatedStarted, false);
    assert.equal(store.read().records.b, undefined);
  } finally { release(); await Promise.all([running, unrelated]); }
  assert.equal(unrelatedStarted, true);
});
