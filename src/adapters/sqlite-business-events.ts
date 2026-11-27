// Host adapter only. Framework runtime uses Web APIs and has no SQLite dependency.
import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope } from '../framework/authoring.js';
export function businessOutbox(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS business_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0)');
  return {
    /** The caller owns the transaction containing state and receipt writes. */
    append(events: readonly EventEnvelope[]) {
      for (const event of events) db.prepare('INSERT INTO business_events(id,type,payload) VALUES(?,?,?)').run(event.id, event.type, JSON.stringify(event.payload));
    },
    pending(): readonly EventEnvelope[] {
      return db.prepare('SELECT id,type,payload FROM business_events WHERE delivered=0 ORDER BY rowid').all().map(row => ({ id: String(row.id), type: String(row.type), payload: JSON.parse(String(row.payload)) as unknown }));
    },
    acknowledge(id: string) { db.prepare('UPDATE business_events SET delivered=1 WHERE id=?').run(id); },
  };
}
