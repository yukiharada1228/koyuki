import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import type { BookingRepository } from './business.js';
import { restoreBooking, bookingConfirmedName, type Confirmed, type Actor, type Booking, type Input } from './domain.js';
/** Host adapter: state + outbox share one short synchronous transaction. */
export class SqliteBookings implements BookingRepository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);`);
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
