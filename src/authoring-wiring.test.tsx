/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result, type Execution } from './framework/index.js';
import { h, Fragment, createApplication, type EventEnvelope } from './framework/authoring.js';
import { BookingBusiness, AutomaticBookingBusiness, NotificationBusiness, ActorContext, submitBooking, approveBooking, requestAutomaticApproval, bookingConfirmed, type BookingRepository, type Mail } from './experiments/declarative-booking/business.js';
import type { Booking } from './experiments/declarative-booking/domain.js';
function fixture(failSave = false, failDelivery = false) {
  let booking: Booking = { kind: 'draft', id: 'one', owner: 'alice', startsAt: 2_000_000_000_000 };
  const outbox: EventEnvelope[] = [], sent: Mail[] = [];
  let loads = 0, saves = 0;
  const repository: BookingRepository = {
    async load(input) { loads++; return input.id === booking.id ? ok({ ...booking }) : err('Missing'); },
    async approvalReceipt(input, actor) {
      for (const event of outbox) if (event.type === bookingConfirmed.name) {
        const decoded = bookingConfirmed.decode!(event.payload);
        if (decoded.ok && decoded.value.id === input.id && decoded.value.approvedBy === actor.id) return ok({ kind: 'found', value: decoded.value });
      }
      return ok({ kind: 'missing' });
    },
    async commit<S extends Booking>(value: S, _input: { id: string }, events: readonly EventEnvelope[]): Promise<Result<Extract<Execution<S>, { kind: 'committed' }>, 'StorageFailed'>> {
      if (failSave || (value.kind === 'requested' && booking.kind !== 'draft') || (value.kind === 'confirmed' && booking.kind !== 'requested')) return err('StorageFailed');
      booking = value; outbox.push(...events); saves++; return ok({ kind: 'committed', value });
    },
  };
  const sender = { async send(mail: Mail): Promise<Result<null, 'DeliveryUnavailable'>> { if (failDelivery) return err('DeliveryUnavailable'); sent.push(mail); return ok(null); } };
  const app = (id: string, role: 'member' | 'manager') => createApplication(<ActorContext.Provider value={{ id, role }}><Fragment><BookingBusiness repository={repository} /><NotificationBusiness sender={sender} /></Fragment></ActorContext.Provider>);
  return { app, repository, sender, outbox, sent, get booking() { return booking; }, get loads() { return loads; }, get saves() { return saves; } };
}
test('declared needs and On connect submission, approval, atomic event save and notification without caller Result plumbing', async () => {
  const f = fixture(), owner = f.app('alice', 'member'), manager = f.app('boss', 'manager');
  assert.equal(f.loads, 0); assert.equal(f.saves, 0);
  assert((await owner.execute(submitBooking, { id: 'one' })).ok);
  const report = await manager.executeDetailed(approveBooking, { id: 'one' });
  assert(report.result.ok); assert.equal(f.booking.kind, 'confirmed');
  assert.deepEqual(f.sent, [{ bookingId: 'one', owner: 'alice' }]);
  assert.equal(f.outbox.length, 1); assert.equal(report.publications[0]?.id, f.outbox[0]?.id);
  assert.deepEqual(report.deliveries.map(row => [row.operation, row.status]), [['booking.notify.v1', 'ok']]);
  assert(report.trace.some(row => row.step === 'resource:current-booking'));
  assert(report.deliveries[0]?.trace?.some(row => typeof row === 'object' && row !== null && 'step' in row && row.step === 'prepare-booking-mail'));
  if (false) {
    // @ts-expect-error Resource requirements infer the operation input.
    void manager.execute(approveBooking, { id: 1 });
    // @ts-expect-error Host Actor cannot be supplied through the operation input.
    void manager.execute(approveBooking, { id: 'one', actor: { id: 'boss', role: 'manager' } });
  }
});
test('load, domain and save failure never publish; delivery failure preserves the committed business result', async () => {
  const f = fixture(), owner = f.app('alice', 'member');
  const missing = await owner.executeDetailed(approveBooking, { id: 'missing' });
  assert.deepEqual(missing.result, err('Missing')); assert.equal(missing.publications.length, 0);
  assert((await owner.execute(submitBooking, { id: 'one' })).ok);
  const forbidden = await owner.executeDetailed(approveBooking, { id: 'one' });
  assert.deepEqual(forbidden.result, err('Forbidden')); assert.equal(f.outbox.length, 0); assert.equal(f.sent.length, 0);
  const failing = fixture(true), failure = await failing.app('alice', 'member').executeDetailed(submitBooking, { id: 'one' });
  assert.deepEqual(failure.result, err('StorageFailed')); assert.equal(failing.outbox.length, 0);
  const delivery = fixture(false, true), alice = delivery.app('alice', 'member'), boss = delivery.app('boss', 'manager');
  await alice.execute(submitBooking, { id: 'one' });
  const approved = await boss.executeDetailed(approveBooking, { id: 'one' });
  assert(approved.result.ok); assert.equal(delivery.booking.kind, 'confirmed'); assert.equal(delivery.outbox.length, 1);
  assert.equal(approved.deliveries[0]?.status, 'error'); assert.equal(approved.deliveries[0]?.error, 'DeliveryUnavailable');
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// Use a concrete call so each operation retains its own closed error set.
async function inferredContract() {
  const app = fixture().app('boss', 'manager');
  const report = await app.executeDetailed(approveBooking, { id: 'one' });
  type Failure = Extract<typeof report.result, { ok: false }>['error'];
  const exact: Equal<Failure, 'Missing' | 'StorageFailed' | 'InvalidState' | 'Forbidden' | 'SelfApproval'> = true;
  void exact;
}
void inferredContract;

test('persisted event recovery validates the payload and routes without re-running the approved business operation', async () => {
  const f = fixture(false, true), owner = f.app('alice', 'member'), boss = f.app('boss', 'manager');
  await owner.execute(submitBooking, { id: 'one' });
  await boss.execute(approveBooking, { id: 'one' });
  const recovered: Mail[] = [];
  const receiver = createApplication(<NotificationBusiness sender={{ async send(mail) { recovered.push(mail); return ok(null); } }} />);
  const invalid = await receiver.deliver({ ...f.outbox[0]!, payload: { kind: 'confirmed', id: 'one' } });
  assert.equal(invalid.deliveries[0]?.status, 'error'); assert.equal(recovered.length, 0);
  const report = await receiver.deliver(f.outbox[0]!);
  assert.equal(report.deliveries[0]?.status, 'ok'); assert.equal(recovered.length, 1);
  assert.equal(f.saves, 2); assert.equal(f.booking.kind, 'confirmed');
});

test('one declared request drives approval and notification when an automatic-approval policy is explicitly assembled', async () => {
  const f = fixture();
  const app = createApplication(<ActorContext.Provider value={{ id: 'alice', role: 'member' }}><Fragment>
    <AutomaticBookingBusiness repository={f.repository} approver={{ id: 'boss', role: 'manager' }} />
    <NotificationBusiness sender={f.sender} />
  </Fragment></ActorContext.Provider>);
  const report = await app.executeDetailed(requestAutomaticApproval, { id: 'one' });
  assert(report.result.ok); assert.equal(f.booking.kind, 'confirmed');
  assert.deepEqual(report.deliveries.map(delivery => [delivery.operation, delivery.status]), [['booking.approve-automatic.v1', 'ok'], ['booking.notify.v1', 'ok']]);
  assert.deepEqual(f.sent, [{ bookingId: 'one', owner: 'alice' }]); assert.equal(f.saves, 2); assert.equal(f.outbox.length, 2);
  const redelivered = await app.deliver(f.outbox[0]!);
  assert.equal(redelivered.deliveries[0]?.status, 'ok'); assert.equal(f.saves, 2); assert.equal(f.sent.length, 1);
});
