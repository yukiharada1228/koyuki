import { ok, err, type Result, type Receipt, type Execution } from '../framework/index.js';
import { digestToken } from './secrets.js';
import { RegistrationRepository } from './repository.js';
import { restore, type Registration, type Change } from './domain.js';
import type { RegistrationCall, RegistrationStorageError } from '../experiments/react-business/registration.js';
function valid(call: RegistrationCall): boolean {
  const input = call.input;
  return typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 200 && input.requestId.trim() === input.requestId
    && typeof input.id === 'string' && input.id.trim().length > 0
    && (call.operation === 'request' ? typeof call.input.email === 'string'
      : call.operation === 'confirm' && typeof call.input.token === 'string' && Number.isSafeInteger(call.input.now) && call.input.now >= 0);
}
async function fingerprint(call: RegistrationCall) {
  const input = call.input;
  const fields = ['registration.v1', call.operation, call.actor.id, call.actor.role, call.actor.active, input.id,
    call.operation === 'request' ? call.input.email : call.input.token,
    call.operation === 'confirm' ? call.input.now : null];
  return digestToken(JSON.stringify(fields));
}
/** Demonstration SQLite adapter: state, outbox, and receipt share one transaction. */
export class ReplayRegistrationRepository extends RegistrationRepository {
  constructor(path: string) {
    super(path);
    try { this.db.exec('CREATE TABLE IF NOT EXISTS registration_receipts(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL)'); }
    catch (cause) { this.close(); throw cause; }
  }
  private lookup(call: RegistrationCall, key: string): Result<Receipt<Registration>, RegistrationStorageError> {
    const row = this.db.prepare('SELECT * FROM registration_receipts WHERE request_id=?').get(call.input.requestId);
    if (!row) return ok({ kind: 'missing' });
    if (row.fingerprint !== key) return err({ kind: 'IdempotencyConflict' });
    let raw: unknown;
    try { raw = JSON.parse(String(row.result_json)); } catch { return err({ kind: 'CorruptRegistration' }); }
    const state = restore(raw);
    if (!state.ok) return state;
    if (state.value.id !== call.input.id || state.value.kind !== (call.operation === 'request' ? 'awaiting' : 'confirmed')) return err({ kind: 'CorruptRegistration' });
    return ok({ kind: 'found', value: state.value });
  }
  async receipt(call: RegistrationCall): Promise<Result<Receipt<Registration>, RegistrationStorageError>> {
    if (!valid(call)) return err({ kind: 'InvalidRequest' });
    try { return this.lookup(call, await fingerprint(call)); } catch { return err({ kind: 'StorageUnavailable' }); }
  }
  async saveRequest(call: RegistrationCall, change: Change): Promise<Result<Execution<Registration>, RegistrationStorageError>> {
    if (!valid(call)) return err({ kind: 'InvalidRequest' });
    try {
      const key = await fingerprint(call);
      const confirmationDigest = call.operation === 'confirm'
        ? await digestToken(call.input.token) : null;
      this.db.exec('BEGIN IMMEDIATE');
      const cached = this.lookup(call, key);
      if (!cached.ok) { this.db.exec('ROLLBACK'); return cached; }
      if (cached.value.kind === 'found') { this.db.exec('COMMIT'); return ok({ kind: 'replayed', value: cached.value.value }); }
      const matches = change.next.id === call.input.id && (call.operation === 'request'
        ? change.expectedVersion === 0 && change.next.kind === 'awaiting' && change.next.email === call.input.email
        : change.expectedVersion === 1 && change.next.kind === 'confirmed' && change.next.confirmedAt === call.input.now);
      if (!matches) { this.db.exec('ROLLBACK'); return err({ kind: 'InvalidRequest' }); }
      if (call.operation === 'confirm') {
        const current = this.read(call.input.id);
        if (!current.ok) { this.db.exec('ROLLBACK'); return current; }
        if (current.value?.kind !== 'awaiting' || current.value.tokenDigest !== confirmationDigest || current.value.email !== change.next.email) {
          this.db.exec('ROLLBACK'); return err({ kind: 'InvalidRequest' });
        }
      }
      const saved = this.commit(change);
      if (!saved.ok) { this.db.exec('ROLLBACK'); return saved; }
      this.db.prepare('INSERT INTO registration_receipts VALUES(?,?,?)').run(call.input.requestId, key, JSON.stringify(saved.value));
      this.db.exec('COMMIT');
      return ok({ kind: 'committed', value: saved.value });
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      return err({ kind: 'StorageUnavailable' });
    }
  }
}
