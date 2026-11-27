import { businessOutbox } from '../../adapters/sqlite-business-events.js';
import type { EventEnvelope } from '../../framework/authoring.js';
// Example adapter only. Node and SQLite are not dependencies of koyuki/experimental.
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Result, type Receipt, type Execution } from '../../framework/index.js';
import type { Actor } from '../../expenses/domain.js';
import type { LeaveState, PendingLeave, ApprovedLeave, LeaveContext, LeaveInput } from './leave-domain.js';
import type { ReplayLeaveRepository, LeaveIdentity, LeaveStorageError } from './leave-replay.js';
function restore(value: unknown): Result<LeaveState, LeaveStorageError> {
  if (!value || typeof value !== 'object') return err('CorruptLeave');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || typeof v.owner !== 'string' || !v.owner || typeof v.days !== 'number' || !Number.isSafeInteger(v.days) || v.days <= 0) return err('CorruptLeave');
  const base = { id: v.id, owner: v.owner, days: v.days };
  if (v.kind === 'pending') return ok({ ...base, kind: 'pending' });
  if (v.kind === 'approved' && typeof v.by === 'string' && v.by && v.by !== v.owner) return ok({ ...base, kind: 'approved', by: v.by });
  return err('CorruptLeave');
}
function valid(request: LeaveIdentity) {
  return typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 200 && request.requestId.trim() === request.requestId
    && typeof request.input.id === 'string' && request.input.id.length > 0;
}
async function fingerprint(request: LeaveIdentity) {
  const { actor } = request;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['leave.approve.v1', request.input.id, actor.id, actor.role, actor.active])));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export class SqliteReplayLeaves implements ReplayLeaveRepository {
  private readonly db: DatabaseSync;
  readonly events: ReturnType<typeof businessOutbox>;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS leaves(id TEXT PRIMARY KEY,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS leave_receipts(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL)');
    this.events = businessOutbox(this.db);
  }
  close() { this.db.close(); }
  seed(value: PendingLeave) {
    const checked = restore(value);
    if (!checked.ok) throw new Error('InvalidLeaveSeed');
    this.db.prepare('INSERT INTO leaves VALUES(?,?)').run(value.id, JSON.stringify(checked.value));
  }
  async load(input: LeaveInput, actor: Actor): Promise<Result<LeaveContext, LeaveStorageError>> {
    try {
      const row = this.db.prepare('SELECT state FROM leaves WHERE id=?').get(input.id);
      if (!row) return err('NotFound');
      const current = restore(JSON.parse(String(row.state)));
      return current.ok && current.value.id === input.id ? ok({ current: current.value, actor }) : err('CorruptLeave');
    } catch (cause) { return err(cause instanceof SyntaxError ? 'CorruptLeave' : 'StorageUnavailable'); }
  }
  private lookup(request: LeaveIdentity, key: string): Result<Receipt<ApprovedLeave>, LeaveStorageError> {
    const row = this.db.prepare('SELECT * FROM leave_receipts WHERE request_id=?').get(request.requestId);
    if (!row) return ok({ kind: 'missing' });
    if (row.fingerprint !== key) return err('IdempotencyConflict');
    const result = restore(JSON.parse(String(row.result_json)));
    return result.ok && result.value.kind === 'approved' && result.value.id === request.input.id && result.value.by === request.actor.id
      ? ok({ kind: 'found', value: result.value }) : err('CorruptLeave');
  }
  async receipt(request: LeaveIdentity): Promise<Result<Receipt<ApprovedLeave>, LeaveStorageError>> {
    if (!valid(request)) return err('InvalidRequest');
    try { return this.lookup(request, await fingerprint(request)); }
    catch (cause) { return err(cause instanceof SyntaxError ? 'CorruptLeave' : 'StorageUnavailable'); }
  }
  async saveRequest(request: LeaveIdentity, next: ApprovedLeave, events: readonly EventEnvelope[] = []): Promise<Result<Execution<ApprovedLeave>, LeaveStorageError>> {
    if (!valid(request)) return err('InvalidRequest');
    try {
      const key = await fingerprint(request);
      // Await all IO preparation before entering the synchronous transaction.
      this.db.exec('BEGIN IMMEDIATE');
      const cached = this.lookup(request, key);
      if (!cached.ok) { this.db.exec('ROLLBACK'); return cached; }
      if (cached.value.kind === 'found') { this.db.exec('COMMIT'); return ok({ kind: 'replayed', value: cached.value.value }); }
      const checked = restore(next);
      const row = this.db.prepare('SELECT state FROM leaves WHERE id=?').get(request.input.id);
      const current = row ? restore(JSON.parse(String(row.state))) : err('NotFound' as const);
      if (!checked.ok || checked.value.kind !== 'approved' || checked.value.id !== request.input.id || checked.value.by !== request.actor.id) { this.db.exec('ROLLBACK'); return err('InvalidRequest'); }
      if (!current.ok) { this.db.exec('ROLLBACK'); return current; }
      if (current.value.kind !== 'pending' || current.value.owner !== next.owner || current.value.days !== next.days) { this.db.exec('ROLLBACK'); return err('SaveConflict'); }
      this.db.prepare('UPDATE leaves SET state=? WHERE id=?').run(JSON.stringify(checked.value), next.id);
      this.db.prepare('INSERT INTO leave_receipts VALUES(?,?,?)').run(request.requestId, key, JSON.stringify(checked.value));
      this.events.append(events);
      this.db.exec('COMMIT'); return ok({ kind: 'committed', value: checked.value });
    } catch (cause) {
      try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      return err(cause instanceof SyntaxError ? 'CorruptLeave' : 'StorageUnavailable');
    }
  }
}
