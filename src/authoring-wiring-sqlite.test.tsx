/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, err } from './framework/index.js';
import { h, Fragment, createApplication } from './framework/authoring.js';
import { BookingBusiness, NotificationBusiness, ActorContext, submitBooking, approveBooking, type Mail } from './experiments/declarative-booking/business.js';
import { SqliteBookings } from './experiments/declarative-booking/sqlite.js';
test('state and emitted events roll back together; a new process can deliver the persisted event without re-approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-event-wiring-')), path = join(directory, 'booking.sqlite');
  let repository = new SqliteBookings(path);
  try {
    repository.seed({ kind: 'draft', id: 'one', owner: 'alice', startsAt: 2_000_000_000_000 });
    const sender = { async send(_mail: Mail) { return err('DeliveryUnavailable' as const); } };
    const make = (id: string, role: 'member' | 'manager') => createApplication(<ActorContext.Provider value={{ id, role }}><Fragment><BookingBusiness repository={repository} /><NotificationBusiness sender={sender} /></Fragment></ActorContext.Provider>);
    const owner = make('alice', 'member'), manager = make('boss', 'manager');
    assert((await owner.execute(submitBooking, { id: 'one' })).ok);
    repository.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON booking_outbox BEGIN SELECT RAISE(ABORT, 'outbox failed'); END");
    const failed = await manager.executeDetailed(approveBooking, { id: 'one' });
    assert.deepEqual(failed.result, err('StorageFailed')); assert.equal(failed.deliveries.length, 0);
    assert.equal(repository.pending().length, 0);
    const current = await repository.load({ id: 'one' }); assert(current.ok); assert.equal(current.value.kind, 'requested');
    repository.db.exec('DROP TRIGGER reject_event');
    const first = await manager.executeDetailed(approveBooking, { id: 'one' });
    assert(first.result.ok); assert.equal(first.deliveries[0]?.status, 'error');
    const eventId = repository.pending()[0]!.id;
    repository.close(); repository = new SqliteBookings(path);
    const received: Mail[] = [];
    const receiver = createApplication(<NotificationBusiness sender={{ async send(mail) { received.push(mail); return ok(null); } }} />);
    for (const event of repository.pending()) {
      const report = await receiver.deliver(event);
      assert(report.deliveries.every(delivery => delivery.status === 'ok'));
      repository.acknowledge(event.id);
    }
    assert.deepEqual(received, [{ bookingId: 'one', owner: 'alice' }]); assert.equal(repository.pending().length, 0);
    assert.equal(first.publications[0]?.id, eventId);
    const stored = await repository.load({ id: 'one' }); assert(stored.ok); assert.equal(stored.value.kind, 'confirmed');
    repository.db.prepare('UPDATE bookings SET data=? WHERE id=?').run('{}', 'one');
    const corrupt = await make('boss', 'manager').executeDetailed(approveBooking, { id: 'one' });
    assert.deepEqual(corrupt.result, err('StorageFailed')); assert.equal(corrupt.deliveries.length, 0);
  } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
});
