/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, err, type Result } from './framework/index.js';
import { h, Fragment, createApplicationTemplate } from './framework/authoring.js';
import { ActorContext } from './experiments/declarative-booking/business.js';
import { bookingId, actorId, type Confirmed } from './experiments/declarative-booking/domain.js';
import { paymentId, feeCancellation, restoreCancellationSettlement, type CancellationFacts } from './experiments/declarative-booking/cancellation-domain.js';
import { FeeCancellationBusiness, CancellationRefunds, cancelBookingWithFee, parseCancellationRequest, type FeeCancellationRepository, type RefundRequest } from './experiments/declarative-booking/cancellation.js';
import { SqliteFeeBookings } from './experiments/declarative-booking/cancellation-sqlite.js';
function valid<T, E>(value: Result<T, E>): T { if (!value.ok) throw new Error('InvalidFixture'); return value.value; }
const hour = 3600000, startsAt = 2000000000000;
const booking: Confirmed = { kind: 'confirmed', id: valid(bookingId('one')), owner: valid(actorId('alice')), approvedBy: valid(actorId('boss')), startsAt };
const facts: CancellationFacts = { paymentId: valid(paymentId('payment-one')), paidMinor: 10001, membership: 'standard', paymentRevision: 1, membershipRevision: 1 };
const request = { id: booking.id, requestId: 'cancel-one' };
function context(now = startsAt - hour) { return { booking, actor: { id: booking.owner, role: 'member' as const }, facts, time: { now, lateWithinHours: 24, lateFeeBps: 5000 } }; }
function seed(path = ':memory:') { const db = new SqliteFeeBookings(path); db.seed(booking); db.seedPayment(request, facts, booking.owner); return db; }
function app(repository: FeeCancellationRepository, refund: (input: RefundRequest) => Promise<Result<null, 'RefundUnavailable' | 'RefundConflict'>> = async () => ok(null), actor = booking.owner) {
  const template = createApplicationTemplate(<Fragment><FeeCancellationBusiness repository={repository} clock={() => startsAt - hour} /><CancellationRefunds gateway={{ refund }} /></Fragment>);
  return template.scope(children => <ActorContext.Provider value={{ id: actor, role: 'member' }}>{children}</ActorContext.Provider>);
}
test('fee calculation preserves input, rounds integer money, and respects exact deadline and premium membership', () => {
  const before = structuredClone(context());
  const result = feeCancellation.run(before); assert(result.ok);
  assert.equal(result.value.feeMinor, 5001); assert.equal(result.value.refundMinor, 5000);
  assert.deepEqual(before, context());
  const onBoundary = feeCancellation.run(context(startsAt - 24 * hour)); assert(onBoundary.ok); assert.equal(onBoundary.value.feeMinor, 0);
  const late = feeCancellation.run(context(startsAt - 24 * hour + 1)); assert(late.ok); assert.equal(late.value.feeMinor, 5001);
  assert.deepEqual(feeCancellation.run(context(startsAt)), err('CancellationClosed'));
  assert.deepEqual(feeCancellation.run({ ...context(), actor: { id: valid(actorId('other')), role: 'member' } }), err('Forbidden'));
  const premium = feeCancellation.run({ ...context(), facts: { ...facts, membership: 'premium' } }); assert(premium.ok); assert.equal(premium.value.refundMinor, facts.paidMinor);
  for (const paidMinor of [-1, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(feeCancellation.run({ ...context(), facts: { ...facts, paidMinor } }), err('InvalidPayment'));
  const maximum = feeCancellation.run({ ...context(), facts: { ...facts, paidMinor: Number.MAX_SAFE_INTEGER } }); assert(maximum.ok); assert.equal(maximum.value.feeMinor + maximum.value.refundMinor, Number.MAX_SAFE_INTEGER);
  for (const bps of [-1, 10001, 0.1]) assert.deepEqual(feeCancellation.run({ ...context(), time: { ...context().time, lateFeeBps: bps } }), err('InvalidFeePolicy'));
  assert(!restoreCancellationSettlement({ ...result.value, refundMinor: 99999 }).ok);
  assert(!parseCancellationRequest({ id: 'one' }).ok);
  if (false) {
    // @ts-expect-error Booking IDs cannot be used as payment IDs.
    const invalid: CancellationFacts = { ...facts, paymentId: booking.id }; void invalid;
  }
});
test('mount and malformed requests do no IO; non-owners cannot fetch payment facts or save', async () => {
  const db = seed(); let loads = 0, reads = 0, saves = 0;
  try {
    const repository: FeeCancellationRepository = { cancellationReceipt: db.cancellationReceipt.bind(db), async load(input) { loads++; return db.load(input); }, async cancellationFacts(...args) { reads++; return db.cancellationFacts(...args); }, async cancelWithFee(...args) { saves++; return db.cancelWithFee(...args); } };
    const session = app(repository);
    assert.deepEqual([loads, reads, saves], [0, 0, 0]);
    // @ts-expect-error Request IDs are mandatory; runtime validation also refuses them.
    assert.deepEqual(await session.execute(cancelBookingWithFee, { id: booking.id }), err('InvalidRequestId'));
    assert.deepEqual([loads, reads, saves], [0, 0, 0]);
    assert.deepEqual(await app(repository, undefined, valid(actorId('other'))).execute(cancelBookingWithFee, request), err('Forbidden'));
    assert.deepEqual([loads, reads, saves], [1, 0, 0]);
  } finally { db.close(); }
});
test('stale payment or membership revisions stop commit without state, receipt or event changes', async () => {
  for (const table of ['booking_payments', 'booking_memberships']) {
    const db = seed();
    try {
      const settlement = feeCancellation.run(context()); assert(settlement.ok);
      db.db.exec(`UPDATE ${table} SET revision=revision+1`);
      const result = await db.cancelWithFee({ requestId: request.requestId, settlement: settlement.value }, request, [], { key: request.requestId, actorId: booking.owner, fingerprint: 'stale' });
      assert.deepEqual(result, err('ConcurrentChange'));
      assert.deepEqual((await db.load(request)), ok(booking));
      assert.equal(db.pending().length, 0);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM booking_cancellation_receipts').get()!.n, 0);
    } finally { db.close(); }
  }
});
test('outbox and receipt failures atomically roll cancellation back and stop refunds', async () => {
  for (const table of ['booking_outbox', 'booking_cancellation_receipts']) {
    const db = seed(); let refunds = 0;
    try {
      db.db.exec(`CREATE TRIGGER injected BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
      const result = await app(db, async () => { refunds++; return ok(null); }).execute(cancelBookingWithFee, request);
      assert.deepEqual(result, err('StorageFailed')); assert.equal(refunds, 0);
      assert.deepEqual(await db.load(request), ok(booking)); assert.equal(db.pending().length, 0);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM booking_cancellation_receipts').get()!.n, 0);
    } finally { db.close(); }
  }
});
test('refund failure preserves commit; receipt and outbox survive reopening without cancelling again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-fee-cancel-')), path = join(dir, 'booking.sqlite');
  let db = seed(path), sends = 0; const keys: string[] = [];
  try {
    const first = await app(db, async input => { sends++; keys.push(input.idempotencyKey); return err('RefundUnavailable'); }).executeDetailed(cancelBookingWithFee, request);
    assert(first.result.ok && first.result.value.kind === 'committed'); assert.equal(first.deliveries[0]?.status, 'error');
    const committed = first.result.value.value;
    db.close(); db = new SqliteFeeBookings(path);
    const session = app(db, async input => { sends++; keys.push(input.idempotencyKey); return ok(null); });
    const replay = await session.executeDetailed(cancelBookingWithFee, request);
    assert(replay.result.ok && replay.result.value.kind === 'replayed'); assert.equal(replay.attempt, null); assert.equal(sends, 1);
    assert.deepEqual(replay.result.value.value, committed);
    await session.deliver(db.pending()[0]!); assert.equal(sends, 2); assert.equal(keys[0], keys[1]);
    assert.deepEqual(await app(db, undefined, valid(actorId('other'))).execute(cancelBookingWithFee, request), err('IdempotencyConflict'));
    db.db.prepare('UPDATE booking_cancellation_receipts SET data=?').run('{}');
    const broken = await session.executeDetailed(cancelBookingWithFee, request);
    assert.deepEqual(broken.result, err('StorageFailed')); assert.equal(broken.attempt, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('identical concurrent cancellations commit and publish once', async () => {
  const db = seed(); let sends = 0;
  try {
    const session = app(db, async () => { sends++; return ok(null); });
    const results = await Promise.all([session.execute(cancelBookingWithFee, request), session.execute(cancelBookingWithFee, request)]);
    assert.equal(results.filter(value => value.ok && value.value.kind === 'committed').length, 1);
    assert.equal(results.filter(value => value.ok && value.value.kind === 'replayed').length, 1);
    assert.equal(sends, 1); assert.equal(db.pending().length, 1);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM booking_cancellation_receipts').get()!.n, 1);
  } finally { db.close(); }
});
