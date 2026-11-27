import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import type { RescheduleRequest, ReschedulingIdentity } from './rescheduling-request.js';
import type { ReschedulingRepository } from './rescheduling.js';
import type { BookingRepository } from './business.js';
import { restoreBooking, bookingConfirmedName, type Confirmed, type Actor, type Booking, type Input, type RescheduleChange } from './domain.js';
/** Host adapter: state + outbox share one short synchronous transaction. */
export class SqliteBookings implements BookingRepository, ReschedulingRepository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS booking_rescheduling_receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  seed(booking: Booking) { this.db.prepare('INSERT INTO bookings VALUES (?, ?, ?)').run(booking.id, booking.kind, JSON.stringify(booking)); }
  async load(input: Input): Promise<Result<Booking, 'Missing' | 'StorageFailed'>> {
    try {
      const row = this.db.prepare('SELECT id,kind,data FROM bookings WHERE id=?').get(input.id);
      if (!row) return err('Missing');
      const restored = restoreBooking(JSON.parse(String(row.data)));
      return restored.ok && restored.value.id === row.id && restored.value.kind === row.kind ? restored : err('StorageFailed');
    } catch { return err('StorageFailed'); }
  }
  async approvalReceipt(input: Input, actor: Actor): Promise<Result<Receipt<Confirmed>, 'StorageFailed'>> {
    try {
      for (const row of this.db.prepare('SELECT payload FROM booking_outbox WHERE type=? ORDER BY rowid DESC').all(bookingConfirmedName)) {
        const decoded = restoreBooking(JSON.parse(String(row.payload)));
        if (!decoded.ok || decoded.value.kind !== 'confirmed') return err('StorageFailed');
        if (decoded.value.id === input.id && decoded.value.approvedBy === actor.id) return ok({ kind: 'found', value: decoded.value });
      }
      return ok({ kind: 'missing' });
    } catch { return err('StorageFailed'); }
  }
  private readReschedulingReceipt(input: RescheduleRequest, identity: ReschedulingIdentity): Result<Receipt<Confirmed>, 'StorageFailed' | 'IdempotencyConflict'> {
    if (identity.key !== input.requestId) return err('StorageFailed');
    const row = this.db.prepare('SELECT fingerprint,data FROM booking_rescheduling_receipts WHERE request_id=?').get(identity.key);
    if (!row) return ok({ kind: 'missing' });
    if (row.fingerprint !== identity.fingerprint) return err('IdempotencyConflict');
    const restored = restoreBooking(JSON.parse(String(row.data)));
    return restored.ok && restored.value.kind === 'confirmed' && restored.value.id === input.id && restored.value.owner === identity.actorId && restored.value.startsAt === input.startsAt
      ? ok({ kind: 'found', value: restored.value }) : err('StorageFailed');
  }
  async reschedulingReceipt(input: RescheduleRequest, identity: ReschedulingIdentity): Promise<Result<Receipt<Confirmed>, 'StorageFailed' | 'IdempotencyConflict'>> {
    try { return this.readReschedulingReceipt(input, identity); } catch { return err('StorageFailed'); }
  }
  async reschedule({ previous, next }: RescheduleChange, input: RescheduleRequest, events: readonly EventEnvelope[], identity: ReschedulingIdentity): Promise<Result<Execution<Confirmed>, 'StorageFailed' | 'ConcurrentChange' | 'IdempotencyConflict'>> {
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const cached = this.readReschedulingReceipt(input, identity);
      if (!cached.ok) { this.db.exec('ROLLBACK'); begun = false; return cached; }
      if (cached.value.kind === 'found') { this.db.exec('COMMIT'); begun = false; return ok({ kind: 'replayed', value: cached.value.value }); }
      if (previous.id !== input.id || next.id !== input.id || previous.owner !== identity.actorId || previous.owner !== next.owner || previous.approvedBy !== next.approvedBy || next.startsAt !== input.startsAt) { this.db.exec('ROLLBACK'); begun = false; return err('StorageFailed'); }
      // Compare logical fields, not JSON key order; all three writes share this transaction.
      const changed = this.db.prepare("UPDATE bookings SET data=? WHERE id=? AND kind='confirmed' AND json_extract(data,'$.kind')='confirmed' AND json_extract(data,'$.id')=? AND json_extract(data,'$.owner')=? AND json_extract(data,'$.approvedBy')=? AND json_extract(data,'$.startsAt')=?")
        .run(JSON.stringify(next), input.id, previous.id, previous.owner, previous.approvedBy, previous.startsAt);
      if (changed.changes !== 1) { this.db.exec('ROLLBACK'); begun = false; return err('ConcurrentChange'); }
      for (const event of events) this.db.prepare('INSERT INTO booking_outbox (id,type,payload) VALUES (?,?,?)').run(event.id, event.type, JSON.stringify(event.payload));
      this.db.prepare('INSERT INTO booking_rescheduling_receipts (request_id,fingerprint,data) VALUES (?,?,?)').run(identity.key, identity.fingerprint, JSON.stringify(next));
      this.db.exec('COMMIT'); begun = false;
      return ok({ kind: 'committed', value: next });
    } catch { if (begun) { try { this.db.exec('ROLLBACK'); } catch {} } return err('StorageFailed'); }
  }
  async commit<S extends Booking>(value: S, input: Input, events: readonly EventEnvelope[]): Promise<Result<Extract<Execution<S>, { kind: 'committed' }>, 'StorageFailed'>> {
    const previous = value.kind === 'requested' ? 'draft' : value.kind === 'confirmed' ? 'requested' : undefined;
    if (!previous || value.id !== input.id) return err('StorageFailed');
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const changed = this.db.prepare('UPDATE bookings SET kind=?, data=? WHERE id=? AND kind=?').run(value.kind, JSON.stringify(value), input.id, previous);
      if (changed.changes !== 1) throw new Error('ConcurrentChange');
      for (const event of events) this.db.prepare('INSERT INTO booking_outbox (id,type,payload) VALUES (?,?,?)').run(event.id, event.type, JSON.stringify(event.payload));
      this.db.exec('COMMIT'); return ok({ kind: 'committed', value });
    } catch { if (begun) { try { this.db.exec('ROLLBACK'); } catch {} } return err('StorageFailed'); }
  }
  pending(): readonly EventEnvelope[] {
    return this.db.prepare('SELECT id,type,payload FROM booking_outbox WHERE delivered=0 ORDER BY rowid').all()
      .map(row => ({ id: String(row.id), type: String(row.type), payload: JSON.parse(String(row.payload)) as unknown }));
  }
  acknowledge(id: string) { this.db.prepare('UPDATE booking_outbox SET delivered=1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
