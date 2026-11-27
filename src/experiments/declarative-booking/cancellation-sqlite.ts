import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import { SqliteBookings } from './sqlite.js';
import { paymentId, restoreCancellationRecord, type CancellationFacts } from './cancellation-domain.js';
import type { FeeCancellationRepository, CancellationRequest, CancellationIdentity, CancellationRecord, CancellationStorageError } from './cancellation.js';
import type { ActorId, Input } from './domain.js';
/** Host-only SQLite adapter. Payment/membership data belongs to the server, not the command body. */
export class SqliteFeeBookings extends SqliteBookings implements FeeCancellationRepository {
  constructor(path: string) {
    super(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS booking_payments (booking_id TEXT PRIMARY KEY, payment_id TEXT UNIQUE NOT NULL, paid_minor INTEGER NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_memberships (actor_id TEXT PRIMARY KEY, tier TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_cancellation_receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  seedPayment(input: Input, facts: CancellationFacts, actorId: ActorId) {
    this.db.prepare('INSERT INTO booking_payments VALUES (?,?,?,?)').run(input.id, facts.paymentId, facts.paidMinor, facts.paymentRevision);
    this.db.prepare('INSERT INTO booking_memberships VALUES (?,?,?) ON CONFLICT(actor_id) DO UPDATE SET tier=excluded.tier, revision=excluded.revision').run(actorId, facts.membership, facts.membershipRevision);
  }
  private readFacts(input: Input, actorId: ActorId): Result<CancellationFacts, 'MissingPayment' | 'StorageFailed'> {
    const row = this.db.prepare('SELECT p.payment_id,p.paid_minor,p.revision AS payment_revision,m.tier,m.revision AS membership_revision FROM booking_payments p JOIN booking_memberships m ON m.actor_id=? WHERE p.booking_id=?').get(actorId, input.id);
    if (!row) return err('MissingPayment');
    const id = paymentId(row.payment_id);
    if (!id.ok || typeof row.paid_minor !== 'number' || !Number.isSafeInteger(row.paid_minor) || row.paid_minor < 0 || (row.tier !== 'standard' && row.tier !== 'premium') || typeof row.payment_revision !== 'number' || !Number.isSafeInteger(row.payment_revision) || row.payment_revision < 0 || typeof row.membership_revision !== 'number' || !Number.isSafeInteger(row.membership_revision) || row.membership_revision < 0) return err('StorageFailed');
    return ok({ paymentId: id.value, paidMinor: row.paid_minor, membership: row.tier, paymentRevision: row.payment_revision, membershipRevision: row.membership_revision });
  }
  async cancellationFacts(input: Input, actorId: ActorId): Promise<Result<CancellationFacts, 'MissingPayment' | 'StorageFailed'>> {
    try { return this.readFacts(input, actorId); } catch { return err('StorageFailed'); }
  }
  private readReceipt(input: CancellationRequest, identity: CancellationIdentity): Result<Receipt<CancellationRecord>, 'StorageFailed' | 'IdempotencyConflict'> {
    if (identity.key !== input.requestId) return err('StorageFailed');
    const row = this.db.prepare('SELECT fingerprint,data FROM booking_cancellation_receipts WHERE request_id=?').get(identity.key);
    if (!row) return ok({ kind: 'missing' });
    if (row.fingerprint !== identity.fingerprint) return err('IdempotencyConflict');
    const restored = restoreCancellationRecord(JSON.parse(String(row.data)));
    return restored.ok && restored.value.requestId === input.requestId && restored.value.settlement.next.id === input.id && restored.value.settlement.next.owner === identity.actorId ? ok({ kind: 'found', value: restored.value }) : err('StorageFailed');
  }
  async cancellationReceipt(input: CancellationRequest, identity: CancellationIdentity): Promise<Result<Receipt<CancellationRecord>, 'StorageFailed' | 'IdempotencyConflict'>> {
    try { return this.readReceipt(input, identity); } catch { return err('StorageFailed'); }
  }
  async cancelWithFee(record: CancellationRecord, input: CancellationRequest, events: readonly EventEnvelope[], identity: CancellationIdentity): Promise<Result<Execution<CancellationRecord>, CancellationStorageError>> {
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const cached = this.readReceipt(input, identity);
      if (!cached.ok) { this.db.exec('ROLLBACK'); begun = false; return cached; }
      if (cached.value.kind === 'found') { this.db.exec('COMMIT'); begun = false; return ok({ kind: 'replayed', value: cached.value.value }); }
      const checked = restoreCancellationRecord(record);
      if (!checked.ok || record.requestId !== input.requestId || record.settlement.next.id !== input.id || record.settlement.next.owner !== identity.actorId) { this.db.exec('ROLLBACK'); begun = false; return err('StorageFailed'); }
      const { previous, next, facts } = checked.value.settlement;
      const currentFacts = this.readFacts(input, identity.actorId);
      if (!currentFacts.ok || currentFacts.value.paymentId !== facts.paymentId || currentFacts.value.paidMinor !== facts.paidMinor || currentFacts.value.membership !== facts.membership || currentFacts.value.paymentRevision !== facts.paymentRevision || currentFacts.value.membershipRevision !== facts.membershipRevision) { this.db.exec('ROLLBACK'); begun = false; return err('ConcurrentChange'); }
      const changed = this.db.prepare("UPDATE bookings SET kind='cancelled',data=? WHERE id=? AND kind='confirmed' AND json_extract(data,'$.kind')='confirmed' AND json_extract(data,'$.id')=? AND json_extract(data,'$.owner')=? AND json_extract(data,'$.approvedBy')=? AND json_extract(data,'$.startsAt')=?")
        .run(JSON.stringify(next), input.id, previous.id, previous.owner, previous.approvedBy, previous.startsAt);
      if (changed.changes !== 1) { this.db.exec('ROLLBACK'); begun = false; return err('ConcurrentChange'); }
      for (const event of events) this.db.prepare('INSERT INTO booking_outbox (id,type,payload) VALUES (?,?,?)').run(event.id, event.type, JSON.stringify(event.payload));
      this.db.prepare('INSERT INTO booking_cancellation_receipts VALUES (?,?,?)').run(identity.key, identity.fingerprint, JSON.stringify(checked.value));
      this.db.exec('COMMIT'); begun = false;
      return ok({ kind: 'committed', value: checked.value });
    } catch { if (begun) { try { this.db.exec('ROLLBACK'); } catch {} } return err('StorageFailed'); }
  }
}
