// Demonstration adapter. Node/SQLite stay outside the published core.
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Result } from '../framework/index.js';
import { restore, type Registration, type Change, type EmailRequested } from './domain.js';
export type StorageError = { kind: 'StorageUnavailable' } | { kind: 'Conflict' } | { kind: 'CorruptRegistration' };
export interface Delivery { readonly event: EmailRequested; readonly claim: string }
export class RegistrationRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_outbox(id TEXT PRIMARY KEY, registration_id TEXT NOT NULL REFERENCES registrations(id), payload TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, claim TEXT);`);
  }
  close() { this.db.close(); }
  read(id: string): Result<Registration | null, StorageError> {
    try {
      const row = this.db.prepare('SELECT * FROM registrations WHERE id=?').get(id);
      if (!row) return ok(null);
      const result = restore(JSON.parse(String(row.state)));
      if (!result.ok) return result;
      return result.value.id === row.id && result.value.version === row.version ? result : err({ kind: 'CorruptRegistration' });
    } catch (cause) { return err({ kind: cause instanceof SyntaxError ? 'CorruptRegistration' : 'StorageUnavailable' }); }
  }
  async save(change: Change): Promise<Result<Registration, StorageError>> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.read(change.next.id);
      const restored = restore(change.next);
      if (!existing.ok || !restored.ok) { this.db.exec('ROLLBACK'); return !existing.ok ? existing : restored; }
      if ((existing.value?.version ?? 0) !== change.expectedVersion) { this.db.exec('ROLLBACK'); return err({ kind: 'Conflict' }); }
      if (change.expectedVersion === 0) this.db.prepare('INSERT INTO registrations VALUES(?,?,?)').run(change.next.id, change.next.version, JSON.stringify(change.next));
      else this.db.prepare('UPDATE registrations SET version=?,state=? WHERE id=? AND version=?').run(change.next.version, JSON.stringify(change.next), change.next.id, change.expectedVersion);
      if (change.event) this.db.prepare('INSERT INTO email_outbox(id,registration_id,payload) VALUES(?,?,?)').run(change.event.id, change.next.id, JSON.stringify(change.event));
      this.db.exec('COMMIT'); return ok(restored.value);
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
      return err({ kind: 'StorageUnavailable' });
    }
  }
  async claim(now: number, leaseMs: number): Promise<Result<Delivery, StorageError | { kind: 'EmptyOutbox' } | { kind: 'InvalidLease' }>> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) return err({ kind: 'InvalidLease' });
    try {
      const token = crypto.randomUUID();
      // One atomic statement. Other connections cannot acquire the same live lease.
      const row = this.db.prepare(`UPDATE email_outbox SET claim=?,lease_until=? WHERE id=(
        SELECT id FROM email_outbox WHERE delivered=0 AND lease_until<=? ORDER BY id LIMIT 1) RETURNING *`).get(token, now + leaseMs, now);
      if (!row) return err({ kind: 'EmptyOutbox' });
      const e: unknown = JSON.parse(String(row.payload));
      if (!e || typeof e !== 'object') return err({ kind: 'CorruptRegistration' });
      const v = e as Record<string, unknown>;
      if (v.type !== 'EmailRequested' || v.id !== row.id || v.registrationId !== row.registration_id || typeof v.email !== 'string' || typeof v.token !== 'string' || !v.token)
        return err({ kind: 'CorruptRegistration' });
      return ok({ event: { type: 'EmailRequested', id: String(v.id), registrationId: String(v.registrationId), email: v.email, token: v.token }, claim: token });
    } catch (cause) { return err({ kind: cause instanceof SyntaxError ? 'CorruptRegistration' : 'StorageUnavailable' }); }
  }
  async acknowledge(delivery: Delivery): Promise<Result<string, StorageError>> {
    try {
      const row = this.db.prepare('UPDATE email_outbox SET delivered=1 WHERE id=? AND claim=? AND delivered=0').run(delivery.event.id, delivery.claim);
      return row.changes === 1 ? ok(delivery.event.id) : err({ kind: 'Conflict' });
    } catch { return err({ kind: 'StorageUnavailable' }); }
  }
  /** Extend only the current, still-live owner; never revive an expired lease. */
  async renew(delivery: Delivery, now: number, leaseMs: number): Promise<Result<void, StorageError | { kind: 'InvalidLease' }>> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) return err({ kind: 'InvalidLease' });
    try {
      const row = this.db.prepare(`UPDATE email_outbox SET lease_until=MAX(lease_until,?)
        WHERE id=? AND claim=? AND delivered=0 AND lease_until>?`).run(now + leaseMs, delivery.event.id, delivery.claim, now);
      return row.changes === 1 ? ok(undefined) : err({ kind: 'Conflict' });
    } catch { return err({ kind: 'StorageUnavailable' }); }
  }
}
