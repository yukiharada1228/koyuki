// Example host adapter. Node's SQLite API is outside the dependency-free framework core.
import { DatabaseSync } from 'node:sqlite';
import { ok, err } from '../../framework/index.js';
import type { Ports } from './application.js';
import type { Customer } from './domain.js';
function restore(value: unknown): Customer | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.groupId !== 'string' || !row.groupId ||
      typeof row.name !== 'string' || !row.name.trim() || typeof row.email !== 'string' ||
      row.email !== row.email.toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ||
      typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) return null;
  return Object.freeze({ id: row.id, groupId: row.groupId, name: row.name, email: row.email, version: row.version });
}
function uniqueConflict(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'errcode' in cause &&
    (cause.errcode === 1555 || cause.errcode === 2067); // PRIMARY KEY / UNIQUE
}
const columns = 'id, group_id AS groupId, name, email, version';
export class SqliteCustomers implements Ports {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly groupId: string) {
    if (!groupId.trim()) throw new Error('InvalidTrustedGroup');
    this.db = new DatabaseSync(path);
    try { this.db.exec(`PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS imported_customers (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 1 AND version <= 9007199254740991),
        UNIQUE(group_id, email)
      ) STRICT;`); } catch (cause) { this.db.close(); throw cause; }
  }
  close(): void { this.db.close(); }
  readonly identify: Ports['identify'] = async request => {
    if (request.groupId !== this.groupId) return err({ kind: 'LookupUnavailable' });
    const row = this.db.prepare(`SELECT ${columns} FROM imported_customers WHERE group_id = ? AND email = ?`).get(this.groupId, request.visitor.email);
    if (!row) return ok({ kind: 'not-identified', request, newId: crypto.randomUUID() });
    const customer = restore(row);
    return customer ? ok({ kind: 'identified', request, customer }) : err({ kind: 'LookupUnavailable' });
  };
  readonly save: Ports['save'] = async decision => {
    const customer = restore(decision.customer);
    if (!customer || customer.groupId !== this.groupId) return err({ kind: 'Conflict' });
    if (decision.kind === 'unchanged') {
      const row = restore(this.db.prepare(`SELECT ${columns} FROM imported_customers WHERE id = ? AND group_id = ?`).get(customer.id, this.groupId));
      return row && row.email === customer.email && row.name === customer.name && row.version === customer.version
        ? ok(row) : err({ kind: 'Conflict' });
    }
    if (decision.kind === 'updated') {
      if (!Number.isSafeInteger(decision.expectedVersion) || decision.expectedVersion < 1 || customer.version !== decision.expectedVersion + 1) return err({ kind: 'Conflict' });
      const result = this.db.prepare('UPDATE imported_customers SET name = ?, version = ? WHERE id = ? AND group_id = ? AND email = ? AND version = ?')
        .run(customer.name, customer.version, customer.id, this.groupId, customer.email, decision.expectedVersion);
      return result.changes === 1 ? ok(customer) : err({ kind: 'Conflict' });
    }
    if (decision.kind !== 'created') throw new Error('UnknownCustomerDecision');
    if (customer.version !== 1) return err({ kind: 'Conflict' });
    try {
      this.db.prepare('INSERT INTO imported_customers(id, group_id, name, email, version) VALUES(?,?,?,?,?)')
        .run(customer.id, this.groupId, customer.name, customer.email, customer.version);
      return ok(customer);
    } catch (cause) {
      if (uniqueConflict(cause)) return err({ kind: 'Conflict' });
      throw cause;
    }
  };
}
