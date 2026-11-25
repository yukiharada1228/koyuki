import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ok, err, type Result, type Receipt, type Execution } from 'koyuki';
import { restoreAccount, validInput, type Account, type Actor, type Input, type SubmitInput, type Loaded, type Change, type Leave } from './domain.js';
export type Operation = 'submit' | 'approve' | 'withdraw';
export interface Request { readonly operation: Operation; readonly actor: Actor; readonly requestId: string; readonly input: Input | SubmitInput }
export type StorageError = { kind: 'InvalidInput' } | { kind: 'NotFound' } | { kind: 'Conflict' } |
  { kind: 'CorruptLeave' } | { kind: 'IdempotencyConflict' } | { kind: 'StorageUnavailable' };
const fingerprint = (r: Request) => createHash('sha256').update(JSON.stringify(['leave.v1', r.operation, r.actor.id, r.actor.role, r.actor.active,
  r.input.employee, r.input.leaveId, r.input.expectedVersion, r.operation === 'submit' && 'days' in r.input ? r.input.days : null])).digest('hex');
function validRequest(r: Request): boolean {
  return !!r && ['submit', 'approve', 'withdraw'].includes(r.operation) && typeof r.requestId === 'string' &&
    r.requestId.length > 0 && r.requestId.length <= 200 && r.requestId.trim() === r.requestId && validInput(r.input) &&
    (r.operation !== 'submit' || ('days' in r.input && Number.isSafeInteger(r.input.days) && r.input.days > 0));
}
export interface LeaveRepository {
  load<I extends Input>(input: I, actor: Actor): Promise<Result<Loaded<I>, StorageError>>;
  receipt(request: Request): Result<Receipt<Account>, StorageError> | Promise<Result<Receipt<Account>, StorageError>>;
  save(request: Request, change: Change): Promise<Result<Execution<Account>, StorageError>>;
}
export class SqliteLeave implements LeaveRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('UnsupportedLeaveSchema');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS accounts(employee TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes(employee TEXT NOT NULL REFERENCES accounts(employee), version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(employee,version));
        CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      this.db.exec('PRAGMA foreign_keys=ON');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  seed(employee: string, granted: number): Result<Account, StorageError> {
    const account = restoreAccount({ employee, granted, version: 1, leaves: [] }); if (!account.ok) return err({ kind: 'InvalidInput' });
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO accounts VALUES(?,1,?)').run(employee, JSON.stringify(account.value));
      return result.changes === 1 ? account : err({ kind: 'Conflict' });
    } catch { return err({ kind: 'StorageUnavailable' }); }
  }
  read(employee: string): Result<Account, StorageError> {
    try {
      const row = this.db.prepare('SELECT * FROM accounts WHERE employee=?').get(employee);
      if (!row) return err({ kind: 'NotFound' });
      const restored = restoreAccount(JSON.parse(String(row.state_json)));
      if (!restored.ok) return restored;
      return restored.value.employee === row.employee && restored.value.version === row.version ? restored : err({ kind: 'CorruptLeave' });
    } catch (error) { return err({ kind: error instanceof SyntaxError ? 'CorruptLeave' : 'StorageUnavailable' }); }
  }
  async load<I extends Input>(input: I, actor: Actor): Promise<Result<Loaded<I>, StorageError>> {
    if (!validInput(input)) return err({ kind: 'InvalidInput' });
    const current = this.read(input.employee); if (!current.ok) return current;
    if (current.value.version !== input.expectedVersion) return err({ kind: 'Conflict' });
    return ok({ account: current.value, input: structuredClone(input), actor: Object.freeze({ ...actor }) });
  }
  receipt(r: Request): Result<Receipt<Account>, StorageError> {
    if (!validRequest(r)) return err({ kind: 'InvalidInput' });
    try {
      const row = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(r.requestId);
      if (!row) return ok({ kind: 'missing' });
      if (row.fingerprint !== fingerprint(r)) return err({ kind: 'IdempotencyConflict' });
      const restored = restoreAccount(JSON.parse(String(row.result_json))); if (!restored.ok) return restored;
      const a = restored.value, leave = a.leaves.find(l => l.id === r.input.leaveId);
      if (a.employee !== r.input.employee || a.version !== r.input.expectedVersion + 1 || !leave ||
          (r.operation === 'submit' ? leave.kind !== 'pending' || !('days' in r.input) || leave.days !== r.input.days
            : r.operation === 'approve' ? leave.kind !== 'approved' || leave.by !== r.actor.id : leave.kind !== 'withdrawn')) return err({ kind: 'CorruptLeave' });
      return ok({ kind: 'found', value: a });
    } catch (error) { return err({ kind: error instanceof SyntaxError ? 'CorruptLeave' : 'StorageUnavailable' }); }
  }
  async save(r: Request, change: Change): Promise<Result<Execution<Account>, StorageError>> {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.commit(r, change);
      this.db.exec(result.ok ? 'COMMIT' : 'ROLLBACK'); return result;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* BEGIN may fail. */ }
      return err({ kind: 'StorageUnavailable' });
    }
  }
  private commit(r: Request, change: Change): Result<Execution<Account>, StorageError> {
    const cached = this.receipt(r); if (!cached.ok) return cached;
    if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
    const current = this.read(r.input.employee); if (!current.ok) return current;
    const restored = restoreAccount(change.next); if (!restored.ok) return restored;
    const before = current.value, next = restored.value;
    if (before.version !== r.input.expectedVersion || before.version !== change.expectedVersion) return err({ kind: 'Conflict' });
    if (next.version !== before.version + 1 || next.employee !== before.employee || next.granted !== before.granted) return err({ kind: 'InvalidInput' });
    const old = before.leaves.find(l => l.id === r.input.leaveId);
    let expected: readonly Leave[];
    if (r.operation === 'submit' && !old && 'days' in r.input) expected = [...before.leaves, { id: r.input.leaveId, days: r.input.days, kind: 'pending' }];
    else if (old?.kind === 'pending' && r.operation !== 'submit') expected = before.leaves.map(l => l.id !== old.id ? l : r.operation === 'approve'
      ? { id: l.id, days: l.days, kind: 'approved', by: r.actor.id } : { id: l.id, days: l.days, kind: 'withdrawn' });
    else return err({ kind: 'InvalidInput' });
    // Compare normalized structures, preserving all unrelated requests and their evidence.
    const expectedAccount = restoreAccount({ ...next, leaves: expected });
    if (!expectedAccount.ok || JSON.stringify(expectedAccount.value) !== JSON.stringify(next)) return err({ kind: 'InvalidInput' });
    const json = JSON.stringify(next);
    const updated = this.db.prepare('UPDATE accounts SET version=?,state_json=? WHERE employee=? AND version=?').run(next.version, json, next.employee, before.version);
    if (updated.changes !== 1) return err({ kind: 'Conflict' });
    this.db.prepare('INSERT INTO changes VALUES(?,?,?)').run(next.employee, next.version, json);
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(r.requestId, fingerprint(r), json);
    return ok({ kind: 'committed', value: next });
  }
}
