import type { DatabaseSync } from 'node:sqlite';
import { auditRecord, type AuditIdentity, type AuditChange } from '../framework/index.js';
/** Host callback must identify the authenticated request executing this save. */
export interface SqliteAuditOptions { readonly identity: (operation: string) => AuditIdentity }
/** Host adapter, outside the dependency-free portable package. No independent commit. */
export class SqliteAudit {
  private readonly identity: SqliteAuditOptions['identity'] | undefined;
  constructor(private readonly db: DatabaseSync, options?: SqliteAuditOptions) {
    this.identity = options?.identity.bind(options);
    if (this.identity) db.exec(`CREATE TABLE IF NOT EXISTS koyuki_audit (
      operation_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, after_version INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(operation_id,target_type,target_id), UNIQUE(target_type,target_id,after_version))`);
  }
  append(operation: string, change: AuditChange): void {
    if (!this.identity) {
      // Once enabled in this database, a reopened/unconfigured writer must not
      // silently bypass audit. Recheck inside the state transaction for old peers.
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='koyuki_audit'").get()) throw new Error('Audit identity required');
      return;
    }
    if (!this.db.isTransaction) throw new Error('Audit requires the state transaction');
    const record = auditRecord(this.identity(operation), operation, change);
    this.db.prepare('INSERT INTO koyuki_audit VALUES(?,?,?,?,?)').run(record.operationId, record.targetType, record.targetId, record.afterVersion, JSON.stringify(record));
  }
}
