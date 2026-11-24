import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ok, err, type Result } from 'koyuki';
import { validInput, validStock, validReservation, validOutcome, type Input, type Operation, type Loaded, type Change, type Outcome, type Stock } from './domain.js';

export type StorageError = { kind: 'NotFound' } | { kind: 'Conflict' } | { kind: 'IdempotencyConflict' } |
  { kind: 'InvalidInput' } | { kind: 'CorruptInventory' } | { kind: 'StorageUnavailable' };
export interface InventoryRepository {
  receipt(operation: Operation, input: Input): Result<Outcome | null, StorageError>;
  load(operation: Operation, input: Input): Promise<Result<Loaded, StorageError>>;
  save(change: Change): Promise<Result<Outcome, StorageError>>;
}
// Explicit tuple canonicalization: object key order and irrelevant JS fields don't affect identity.
const fingerprint = (operation: Operation, input: Input) => createHash('sha256')
  .update(JSON.stringify(['inventory.v1', operation, input.orderId, input.sku, input.quantity])).digest('hex');
export class SqliteInventory implements InventoryRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('UnsupportedInventorySchema');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS stock(sku TEXT PRIMARY KEY, on_hand INTEGER NOT NULL CHECK(on_hand>=0), reserved INTEGER NOT NULL CHECK(reserved>=0 AND reserved<=on_hand), version INTEGER NOT NULL CHECK(version>=1));
        CREATE TABLE IF NOT EXISTS reservations(order_id TEXT PRIMARY KEY, sku TEXT NOT NULL REFERENCES stock(sku), quantity INTEGER NOT NULL CHECK(quantity>0), kind TEXT NOT NULL CHECK(kind IN ('reserved','confirmed','cancelled')), version INTEGER NOT NULL CHECK((kind='reserved' AND version=1) OR (kind IN ('confirmed','cancelled') AND version=2)));
        CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  seed(sku: string, onHand: number): Result<Stock, StorageError> {
    const stock = { sku, onHand, reserved: 0, version: 1 };
    if (!validStock(stock)) return err({ kind: 'InvalidInput' });
    try {
      const saved = this.db.prepare('INSERT OR IGNORE INTO stock VALUES(?,?,0,1)').run(sku, onHand);
      return saved.changes === 1 ? ok(stock) : err({ kind: 'Conflict' });
    } catch { return err({ kind: 'StorageUnavailable' }); }
  }
  stock(sku: string): Result<Stock, StorageError> {
    try {
      const row = this.db.prepare('SELECT sku,on_hand AS onHand,reserved,version FROM stock WHERE sku=?').get(sku);
      if (!row) return err({ kind: 'NotFound' });
      return validStock(row) ? ok(Object.freeze({ ...row })) : err({ kind: 'CorruptInventory' });
    } catch { return err({ kind: 'StorageUnavailable' }); }
  }
  receipt(operation: Operation, input: Input): Result<Outcome | null, StorageError> {
    if (!validInput(input)) return err({ kind: 'InvalidInput' });
    try {
      const row = this.db.prepare('SELECT fingerprint,result_json FROM receipts WHERE request_id=?').get(input.requestId);
      if (!row) return ok(null);
      if (row.fingerprint !== fingerprint(operation, input)) return err({ kind: 'IdempotencyConflict' });
      let value: unknown; try { value = JSON.parse(String(row.result_json)); } catch { return err({ kind: 'CorruptInventory' }); }
      if (!validOutcome(value) || value.reservation.orderId !== input.orderId || value.reservation.sku !== input.sku || value.reservation.quantity !== input.quantity ||
          value.reservation.kind !== (operation === 'reserve' ? 'reserved' : operation === 'confirm' ? 'confirmed' : 'cancelled')) return err({ kind: 'CorruptInventory' });
      return ok(value);
    } catch { return err({ kind: 'StorageUnavailable' }); }
  }
  async load(operation: Operation, input: Input): Promise<Result<Loaded, StorageError>> {
    if (!validInput(input)) return err({ kind: 'InvalidInput' });
    // A read transaction keeps stock and reservation snapshots from different commits apart.
    return this.transaction(false, () => {
      const stock = this.stock(input.sku); if (!stock.ok) return stock;
      const total = this.db.prepare("SELECT coalesce(sum(quantity),0) AS total FROM reservations WHERE sku=? AND kind='reserved'").get(input.sku)?.total;
      if (total !== stock.value.reserved) return err({ kind: 'CorruptInventory' });
      const row = this.db.prepare('SELECT order_id AS orderId,sku,quantity,kind,version FROM reservations WHERE order_id=?').get(input.orderId);
      const reservation: unknown = row ?? { orderId: input.orderId, sku: input.sku, quantity: input.quantity, kind: 'unreserved', version: 0 };
      if (!validReservation(reservation)) return err({ kind: 'CorruptInventory' });
      return ok({ operation, input: Object.freeze({ ...input }), stock: stock.value, reservation: Object.freeze({ ...reservation }) });
    });
  }
  async save(change: Change): Promise<Result<Outcome, StorageError>> {
    return this.transaction(true, () => {
      // Resolve simultaneous identical requests before checking now-stale stock versions.
      const receipt = this.receipt(change.operation, change.input); if (!receipt.ok) return receipt;
      if (receipt.value) return ok(receipt.value);
      const { stock, reservation } = change.next;
      if (!validOutcome(change.next) || stock.version !== change.expectedStockVersion + 1 || reservation.version !== change.expectedReservationVersion + 1 ||
          reservation.orderId !== change.input.orderId || reservation.sku !== change.input.sku || reservation.quantity !== change.input.quantity) return err({ kind: 'CorruptInventory' });
      const current = this.db.prepare('SELECT version FROM reservations WHERE order_id=?').get(reservation.orderId);
      if ((current?.version ?? 0) !== change.expectedReservationVersion) return err({ kind: 'Conflict' });
      const updated = this.db.prepare('UPDATE stock SET on_hand=?,reserved=?,version=? WHERE sku=? AND version=?')
        .run(stock.onHand, stock.reserved, stock.version, stock.sku, change.expectedStockVersion);
      if (updated.changes !== 1) return err({ kind: 'Conflict' });
      if (!current) this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?)')
        .run(reservation.orderId, reservation.sku, reservation.quantity, reservation.kind, reservation.version);
      else this.db.prepare('UPDATE reservations SET kind=?,version=? WHERE order_id=?')
        .run(reservation.kind, reservation.version, reservation.orderId);
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)')
        .run(change.input.requestId, fingerprint(change.operation, change.input), JSON.stringify(change.next));
      return ok(structuredClone(change.next));
    });
  }
  private transaction<T>(write: boolean, body: () => Result<T, StorageError>): Result<T, StorageError> {
    try {
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      const result = body(); this.db.exec(result.ok ? 'COMMIT' : 'ROLLBACK'); return result;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* BEGIN itself may fail. */ }
      return err({ kind: 'StorageUnavailable' });
    }
  }
}
