import { replayAccess, type ReplayRequest, type ReplayError } from './replay-identity.js';
import type { Committed } from './application.js';
// Node host adapter, outside the Web-standard dependency-free framework core.
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import { restoreEntity, type Actor, type Entity, type Change } from './domain.js';
import { MemoryProcurement, type ProcurementRepository, type RelatedKind, type StorageError } from './repository.js';
const conflict = (cause: unknown) => cause !== null && typeof cause === 'object' && 'errcode' in cause &&
  typeof cause.errcode === 'number' && [5, 6, 1555, 2067].includes(cause.errcode);
export class SqliteProcurement implements ProcurementRepository {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly groupId: string) {
    if (!groupId || groupId !== groupId.trim()) throw new Error('InvalidTrustedGroup');
    this.db = new DatabaseSync(path);
    try { this.db.exec(`PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS procurement (
        group_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 1 AND version <= 9007199254740991),
        payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(group_id, kind, id),
        CHECK(json_extract(payload, '$.version') = version),
        CHECK(json_extract(payload, '$.kind') = kind AND json_extract(payload, '$.id') = id AND json_extract(payload, '$.groupId') = group_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS procurement_executions (
        group_id TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL,
        actor_id TEXT NOT NULL, actor_role TEXT NOT NULL, fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(group_id, request_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS procurement_order_parent ON procurement(group_id, json_extract(payload, '$.requestId')) WHERE kind = 'order';
      CREATE INDEX IF NOT EXISTS procurement_receipt_parent ON procurement(group_id, json_extract(payload, '$.orderId')) WHERE kind = 'receipt';
      CREATE INDEX IF NOT EXISTS procurement_invoice_parent ON procurement(group_id, json_extract(payload, '$.orderId')) WHERE kind = 'invoice';
      CREATE INDEX IF NOT EXISTS procurement_payment_parent ON procurement(group_id, json_extract(payload, '$.invoiceId')) WHERE kind = 'payment';
      CREATE UNIQUE INDEX IF NOT EXISTS procurement_order_unique ON procurement(group_id, json_extract(payload, '$.requestId')) WHERE kind = 'order' AND json_extract(payload, '$.state') != 'cancelled';
      CREATE UNIQUE INDEX IF NOT EXISTS procurement_invoice_unique ON procurement(group_id, json_extract(payload, '$.orderId')) WHERE kind = 'invoice' AND json_extract(payload, '$.state') != 'voided';
      CREATE UNIQUE INDEX IF NOT EXISTS procurement_payment_unique ON procurement(group_id, json_extract(payload, '$.invoiceId')) WHERE kind = 'payment' AND json_extract(payload, '$.state') = 'recorded';
      CREATE UNIQUE INDEX IF NOT EXISTS procurement_reference_unique ON procurement(group_id, json_extract(payload, '$.reference')) WHERE kind = 'payment';`);
    } catch (cause) { this.db.close(); throw cause; }
  }
  close(): void { this.db.close(); }
  private decode(row: Record<string, unknown>): Entity {
    let entity: Entity | null = null;
    try { entity = typeof row.payload === 'string' ? restoreEntity(JSON.parse(row.payload)) : null; } catch { /* invalid JSON is corrupt storage */ }
    if (!entity || entity.id !== row.id || entity.kind !== row.kind || entity.groupId !== row.group_id || entity.version !== row.version) throw new Error('CorruptProcurementStorage');
    return entity;
  }
  read<K extends Entity['kind']>(kind: K, id: string, actor: Actor): Result<Extract<Entity, { kind: K }>, StorageError> {
    if (actor.groupId !== this.groupId) return err({ kind: 'NotFound' });
    const row = this.db.prepare('SELECT * FROM procurement WHERE group_id = ? AND kind = ? AND id = ?').get(this.groupId, kind, id);
    if (!row) return err({ kind: 'NotFound' });
    const entity = this.decode(row);
    if (entity.kind !== kind) throw new Error('CorruptProcurementStorage');
    return ok(entity as Extract<Entity, { kind: K }>);
  }
  list<K extends Entity['kind']>(kind: K, actor: Actor): readonly Extract<Entity, { kind: K }>[] {
    if (actor.groupId !== this.groupId) return [];
    return this.db.prepare('SELECT * FROM procurement WHERE group_id = ? AND kind = ? ORDER BY rowid').all(this.groupId, kind)
      .map(row => this.decode(row) as Extract<Entity, { kind: K }>);
  }
  related<K extends RelatedKind>(kind: K, parentId: string, actor: Actor): readonly Extract<Entity, { kind: K }>[] {
    if (actor.groupId !== this.groupId) return [];
    const predicates = {
      order: "kind = 'order' AND json_extract(payload, '$.requestId') = ?",
      receipt: "kind = 'receipt' AND json_extract(payload, '$.orderId') = ?",
      invoice: "kind = 'invoice' AND json_extract(payload, '$.orderId') = ?",
      payment: "kind = 'payment' AND json_extract(payload, '$.invoiceId') = ?",
    };
    const predicate = predicates[kind]; if (!predicate) throw new Error('InvalidProcurementRelation');
    return this.db.prepare(`SELECT * FROM procurement WHERE group_id = ? AND ${predicate} ORDER BY rowid`).all(this.groupId, parentId)
      .map(row => this.decode(row) as Extract<Entity, { kind: K }>);
  }
  lookupExecution(request: ReplayRequest, actor: Actor): Result<Receipt<Committed>, ReplayError> {
    const denied = replayAccess(request, actor); if (denied) return err(denied);
    if (actor.groupId !== this.groupId) return err({ kind: 'Denied' });
    const row = this.db.prepare('SELECT * FROM procurement_executions WHERE group_id = ? AND request_id = ?').get(this.groupId, request.requestId);
    if (!row) return ok({ kind: 'missing' });
    if (row.operation !== request.operation || row.actor_id !== actor.id || row.actor_role !== actor.role || row.fingerprint !== request.fingerprint) return err({ kind: 'ReplayMismatch' });
    let value: Committed | null = null;
    try {
      const payload: unknown = JSON.parse(String(row.payload));
      if (payload && typeof payload === 'object' && 'result' in payload && 'writes' in payload && Array.isArray(payload.writes) && Object.keys(payload).length === 2) {
        const result = restoreEntity(payload.result), writes = payload.writes.map(restoreEntity);
        if (result && result.groupId === this.groupId && writes.length && writes.every((entity): entity is Entity => entity !== null && entity.groupId === this.groupId) &&
            new Set(writes.map(entity => JSON.stringify([entity.kind, entity.id]))).size === writes.length &&
            writes.some(entity => JSON.stringify(entity) === JSON.stringify(result))) value = { result, writes };
      }
    } catch { /* malformed receipt remains a storage defect */ }
    if (!value) throw new Error('CorruptProcurementExecution');
    return ok({ kind: 'found', value });
  }
  async commit<T extends Entity>(change: Change<T>, actor: Actor): Promise<Result<T, StorageError>> {
    const result = this.persist(change, actor);
    if (result.ok) return ok(result.value.value.result);
    if (result.error.kind === 'Conflict' || result.error.kind === 'NotFound') return err(result.error);
    throw new Error('UnexpectedProcurementReplayError');
  }
  async commitExecution<T extends Entity>(change: Change<T>, actor: Actor, request: ReplayRequest): Promise<Result<Execution<Committed<T>>, StorageError | ReplayError>> {
    return this.persist(change, actor, request);
  }
  private persist<T extends Entity>(change: Change<T>, actor: Actor, request?: ReplayRequest): Result<Execution<Committed<T>>, StorageError | ReplayError> {
    if (actor.groupId !== this.groupId) return err({ kind: 'Conflict' });
    if (request) { const denied = replayAccess(request, actor); if (denied) return err(denied); }
    // Validate serializability and domain shapes before opening the transaction.
    const writes = change.writes.map(entity => {
      const restored = restoreEntity(entity); if (!restored) throw new Error('InvalidProcurementWrite');
      return { entity: restored, payload: JSON.stringify(restored) };
    });
    const result = structuredClone(change.result);
    const output: Committed<T> = { result, writes: writes.map(write => write.entity) };
    if (request) {
      const restored = restoreEntity(result);
      if (!restored || !writes.some(write => JSON.stringify(write.entity) === JSON.stringify(restored))) throw new Error('InvalidProcurementExecution');
    }
    let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      if (request) {
        const cached = this.lookupExecution(request, actor);
        if (!cached.ok) { this.db.exec('ROLLBACK'); transaction = false; return cached; }
        if (cached.value.kind === 'found') {
          this.db.exec('ROLLBACK'); transaction = false;
          // Stable operation/request identity owns the historical output type.
          return ok({ kind: 'replayed', value: cached.value.value as Committed<T> });
        }
      }
      // Restore only declared preconditions. Cross-row uniqueness is enforced by SQL indexes.
      const read = this.db.prepare('SELECT * FROM procurement WHERE group_id = ? AND kind = ? AND id = ?');
      const current = new Map<string, Entity>();
      for (const condition of change.checks) {
        if (condition.groupId !== this.groupId) { this.db.exec('ROLLBACK'); transaction = false; return err({ kind: 'Conflict' }); }
        const key = JSON.stringify([condition.kind, condition.id]);
        if (current.has(key)) continue;
        const row = read.get(this.groupId, condition.kind, condition.id);
        if (row) current.set(key, this.decode(row));
      }
      const checked = new MemoryProcurement([...current.values()]).apply(change, actor);
      if (!checked.ok) { this.db.exec('ROLLBACK'); transaction = false; return checked; }
      const save = this.db.prepare('INSERT INTO procurement(group_id,kind,id,version,payload) VALUES(?,?,?,?,?) ON CONFLICT(group_id,kind,id) DO UPDATE SET version=excluded.version,payload=excluded.payload');
      for (const { entity, payload } of writes) save.run(entity.groupId, entity.kind, entity.id, entity.version, payload);
      if (request) this.db.prepare('INSERT INTO procurement_executions(group_id,request_id,operation,actor_id,actor_role,fingerprint,payload) VALUES(?,?,?,?,?,?,?)')
        .run(this.groupId, request.requestId, request.operation, actor.id, actor.role, request.fingerprint, JSON.stringify(output));
      this.db.exec('COMMIT'); transaction = false;
      return ok({ kind: 'committed', value: output });
    } catch (cause) {
      if (transaction) this.db.exec('ROLLBACK');
      if (conflict(cause)) return err({ kind: 'Conflict' });
      throw cause;
    }
  }
}
