import { SqliteAudit, type SqliteAuditOptions } from '../adapters/sqlite-audit.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createSyncTransaction, TransactionFailure, ok, err, type Result } from '../framework/index.js';
import { fingerprint } from './identity.js';
import { normalizeLabel, restoreTag, type TagData, type RawTag, type TagInput, type UpdateInput, type CreateCommand, type UpdateCommand, type CreatedTag, type UpdatedTag, type PersistedTag } from './domain.js';
import type { TagRepository, CreateLoadError, UpdateLoadError, SaveError } from './repository.js';
import type { LifecycleRepository, LifecycleInput, LifecycleCommand, LifecycleChange, LifecycleSaved } from './lifecycle.js';
import type { QuotaError } from './domain.js';
type Row = Record<string, unknown>;
export class SqliteTagRepository implements TagRepository, LifecycleRepository {
  private readonly db: DatabaseSync;
  private readonly transaction = createSyncTransaction<'DEFERRED' | 'IMMEDIATE'>({
    begin: mode => { this.db.exec(`BEGIN ${mode ?? 'IMMEDIATE'}`); },
    commit: () => { this.db.exec('COMMIT'); },
    rollback: () => { this.db.exec('ROLLBACK'); },
  });
  private readonly audit: SqliteAudit;
  constructor(path: string, options: { maxTags?: number; audit?: SqliteAuditOptions } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, max_tags INTEGER NOT NULL CHECK(max_tags > 0));
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), label TEXT NOT NULL CHECK(length(label) > 0), label_key TEXT NOT NULL,
        icon_json TEXT NOT NULL, sort_order INTEGER NOT NULL CHECK(sort_order >= 0), version INTEGER NOT NULL CHECK(version > 0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        UNIQUE(group_id, label_key));
      CREATE TABLE IF NOT EXISTS mutation_receipts (operation_id TEXT PRIMARY KEY, signature TEXT NOT NULL, output_json TEXT NOT NULL);
      `);
    this.tx(() => {
      const version = Number(this.one('PRAGMA user_version')?.user_version ?? 0);
      if (version > 2) throw new Error('UnsupportedSchemaVersion');
      const columns = this.all('PRAGMA table_info(tags)');
      if (!columns.some(column => column.name === 'archived')) this.db.exec('ALTER TABLE tags ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))');
      this.db.exec('PRAGMA user_version = 2');
      return ok(undefined);
    });
    const max = options.maxTags ?? 3;
    if (!Number.isSafeInteger(max) || max <= 0) { this.db.close(); throw new Error('InvalidMaxTags'); }
    try { this.audit = new SqliteAudit(this.db, options.audit); }
    catch (error) { this.db.close(); throw error; }
    this.db.prepare('INSERT OR IGNORE INTO groups(id,name,max_tags) VALUES(?,?,?)').run('g', 'メイン', max);
    this.db.prepare('INSERT OR IGNORE INTO groups(id,name,max_tags) VALUES(?,?,?)').run('other', '別グループ', max);
  }
  close(): void { this.db.close(); }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private tx<R extends Result<unknown, unknown>>(work: () => R, mode: 'DEFERRED' | 'IMMEDIATE' = 'IMMEDIATE'): R {
    return this.transaction.run(work, mode);
  }
  private hydrate(row: Row | undefined) {
    if (!row || (row.archived !== 0 && row.archived !== 1)) return err({ kind: 'CorruptStoredTag' as const });
    let icon: unknown; try { icon = JSON.parse(String(row.icon_json)); } catch { return err({ kind: 'CorruptStoredTag' as const }); }
    return restoreTag({ id: row.id, groupId: row.group_id, label: row.label, icon, sortOrder: row.sort_order, version: row.version });
  }
  listGroups(): Result<readonly { id: string; name: string; max: number }[], { kind: 'RepositoryUnavailable' }> {
    try { return ok(this.all('SELECT id,name,max_tags FROM groups ORDER BY id').map(row => ({ id: String(row.id), name: String(row.name), max: Number(row.max_tags) }))); }
    catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  list(groupId: string, archived = false): Result<readonly (RawTag & { archived: boolean })[], CreateLoadError> {
    try {
      return this.tx(() => {
        if (!this.one('SELECT id FROM groups WHERE id=?', groupId)) return err({ kind: 'GroupNotFound' as const });
        const result: (RawTag & { archived: boolean })[] = [];
        for (const row of this.all('SELECT * FROM tags WHERE group_id=? AND archived=? ORDER BY sort_order,id', groupId, archived ? 1 : 0)) {
          const tag = this.hydrate(row); if (!tag.ok) return tag; result.push({ ...tag.value.data, archived: row.archived === 1 });
        }
        return ok(result);
      }, 'DEFERRED');
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  async loadCreate(input: TagInput): Promise<Result<CreateCommand, CreateLoadError>> {
    try {
      return this.tx(() => {
        const group = this.one('SELECT * FROM groups WHERE id=?', input.groupId);
        if (!group) return err({ kind: 'GroupNotFound' as const });
        const tags: PersistedTag[] = [];
        for (const row of this.all('SELECT * FROM tags WHERE group_id=?', input.groupId)) {
          const restored = this.hydrate(row); if (!restored.ok) return restored; tags.push(restored.value);
        }
        return ok({ kind: 'create-unvalidated' as const, input: structuredClone(input), snapshot: {
          newId: randomUUID(), groupId: input.groupId, version: Number(group.version), count: Number(this.one('SELECT count(*) AS n FROM tags WHERE group_id=? AND archived=0', input.groupId)?.n),
          max: Number(group.max_tags), nextSortOrder: tags.length ? Math.max(...tags.map(t => t.data.sortOrder)) + 1 : 0,
          existingLabels: tags.map(t => t.data.label),
        } });
      }, 'DEFERRED');
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  async loadUpdate(input: UpdateInput): Promise<Result<UpdateCommand, UpdateLoadError>> {
    try {
      return this.tx(() => {
        const row = this.one('SELECT * FROM tags WHERE id=?', input.id); if (!row) return err({ kind: 'NotFound' as const });
        const restored = this.hydrate(row); if (!restored.ok) return restored;
        if (row.archived === 1) return err({ kind: 'TagArchived' as const });
        if (input.expectedVersion !== undefined && restored.value.data.version !== input.expectedVersion) return err({ kind: 'SaveConflict' as const });
        const labels: string[] = [];
        for (const peer of this.all('SELECT * FROM tags WHERE group_id=? AND id<>?', restored.value.data.groupId, input.id)) {
          const tag = this.hydrate(peer); if (!tag.ok) return tag; labels.push(tag.value.data.label);
        }
        return ok({ kind: 'update-unvalidated' as const, input: structuredClone(input), current: restored.value, existingLabels: labels });
      }, 'DEFERRED');
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  private receipt(key: string, value: { readonly data: TagData }): Result<PersistedTag, SaveError> | null {
    const row = this.one('SELECT * FROM mutation_receipts WHERE operation_id=?', key); if (!row) return null;
    if (row.signature !== fingerprint(value)) return err({ kind: 'SaveConflict' });
    const current = this.hydrate(this.one('SELECT * FROM tags WHERE id=?', value.data.id)); if (!current.ok) return current;
    return fingerprint(current.value.data) === fingerprint(value.data) ? current : err({ kind: 'SaveConflict' });
  }
  private duplicate(value: { readonly data: TagData }): boolean {
    return Boolean(this.one('SELECT id FROM tags WHERE group_id=? AND label_key=? AND id<>?', value.data.groupId, normalizeLabel(value.data.label), value.data.id));
  }
  private savedReceipt(key: string, value: { readonly data: TagData }, operation: string, beforeVersion: number | null): void {
    this.db.prepare('INSERT INTO mutation_receipts(operation_id,signature,output_json) VALUES(?,?,?)').run(key, fingerprint(value), JSON.stringify(value.data));
    this.audit.append(operation, { targetType: 'tag', targetId: value.data.id, beforeVersion, afterVersion: value.data.version });
  }
  private failure(error: unknown, label: string): Result<never, SaveError> {
    if (error instanceof TransactionFailure && error.phase === 'work') return this.failure(error.cause, label);
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: tags.group_id, tags.label_key')) return err({ kind: 'DuplicateLabel', label });
    return err({ kind: 'RepositoryUnavailable' });
  }
  async saveCreated(value: CreatedTag): Promise<Result<PersistedTag, SaveError>> {
    try {
      return this.tx(() => {
        const key = `create:${value.data.id}`, replay = this.receipt(key, value); if (replay) return replay;
        if (this.duplicate(value)) return err({ kind: 'DuplicateLabel' as const, label: value.data.label });
        const group = this.one('SELECT * FROM groups WHERE id=?', value.data.groupId);
        if (!group || group.version !== value.expectedGroupVersion || value.data.version !== 1 || this.one('SELECT id FROM tags WHERE id=?', value.data.id)) return err({ kind: 'SaveConflict' as const });
        const count = this.one('SELECT count(*) AS n FROM tags WHERE group_id=? AND archived=0', value.data.groupId);
        if (Number(count?.n) >= Number(group.max_tags)) return err({ kind: 'SaveConflict' as const });
        const restored = restoreTag(value.data); if (!restored.ok) return restored;
        this.db.prepare('INSERT INTO tags(id,group_id,label,label_key,icon_json,sort_order,version) VALUES(?,?,?,?,?,?,?)')
          .run(value.data.id, value.data.groupId, value.data.label, normalizeLabel(value.data.label), JSON.stringify(value.data.icon), value.data.sortOrder, value.data.version);
        this.db.prepare('UPDATE groups SET version=version+1 WHERE id=?').run(value.data.groupId);
        this.savedReceipt(key, value, 'tag.create.v1', null); return restored;
      });
    } catch (error) { return this.failure(error, value.data.label); }
  }
  async saveUpdated(value: UpdatedTag): Promise<Result<PersistedTag, SaveError>> {
    try {
      return this.tx(() => {
        const key = `update:${value.data.id}:${value.expectedVersion}`, replay = this.receipt(key, value); if (replay) return replay;
        const currentRow = this.one('SELECT * FROM tags WHERE id=?', value.data.id);
        if (!currentRow || currentRow.archived === 1) return err({ kind: 'SaveConflict' as const });
        const current = this.hydrate(currentRow); if (!current.ok) return current;
        if (current.value.data.version !== value.expectedVersion || value.data.version !== value.expectedVersion + 1 || current.value.data.groupId !== value.data.groupId || current.value.data.sortOrder !== value.data.sortOrder) return err({ kind: 'SaveConflict' as const });
        if (this.duplicate(value)) return err({ kind: 'DuplicateLabel' as const, label: value.data.label });
        const restored = restoreTag(value.data); if (!restored.ok) return restored;
        this.db.prepare('UPDATE tags SET label=?,label_key=?,icon_json=?,version=? WHERE id=? AND version=?')
          .run(value.data.label, normalizeLabel(value.data.label), JSON.stringify(value.data.icon), value.data.version, value.data.id, value.expectedVersion);
        this.db.prepare('UPDATE groups SET version=version+1 WHERE id=?').run(value.data.groupId);
        this.savedReceipt(key, value, 'tag.update.v1', value.expectedVersion); return restored;
      });
    } catch (error) { return this.failure(error, value.data.label); }
  }
  async loadLifecycle(input: LifecycleInput): Promise<Result<LifecycleCommand, UpdateLoadError>> {
    try {
      return this.tx(() => {
        const row = this.one('SELECT * FROM tags WHERE id=?', input.id);
        if (!row) return err({ kind: 'NotFound' as const });
        const tag = this.hydrate(row); if (!tag.ok) return tag;
        if (tag.value.data.version !== input.expectedVersion) return err({ kind: 'SaveConflict' as const });
        const group = this.one('SELECT * FROM groups WHERE id=?', tag.value.data.groupId);
        if (!group) return err({ kind: 'CorruptStoredTag' as const });
        return ok({ kind: row.archived === 1 ? 'archived' as const : 'active' as const, current: tag.value,
          activeCount: Number(this.one('SELECT count(*) AS n FROM tags WHERE group_id=? AND archived=0', tag.value.data.groupId)?.n), max: Number(group.max_tags) });
      }, 'DEFERRED');
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }
  async saveLifecycle(value: LifecycleChange): Promise<Result<LifecycleSaved, SaveError | QuotaError>> {
    try {
      return this.tx(() => {
        const key = `${value.kind}:${value.data.id}:${value.expectedVersion}`, target = value.kind === 'archive' ? 1 : 0;
        const row = this.one('SELECT * FROM tags WHERE id=?', value.data.id);
        const replay = this.receipt(key, value);
        if (replay) return !replay.ok ? replay : row?.archived === target
          ? ok({ kind: target ? 'archived' as const : 'active' as const, tag: replay.value }) : err({ kind: 'SaveConflict' as const });
        if (!row || row.archived === target) return err({ kind: 'SaveConflict' as const });
        const current = this.hydrate(row); if (!current.ok) return current;
        if (current.value.data.version !== value.expectedVersion || value.data.version !== value.expectedVersion + 1 ||
          fingerprint({ ...value.data, version: current.value.data.version }) !== fingerprint(current.value.data)) return err({ kind: 'SaveConflict' as const });
        if (!target) {
          const group = this.one('SELECT * FROM groups WHERE id=?', value.data.groupId);
          const count = Number(this.one('SELECT count(*) AS n FROM tags WHERE group_id=? AND archived=0', value.data.groupId)?.n);
          if (!group) return err({ kind: 'CorruptStoredTag' as const });
          if (count >= Number(group.max_tags)) return err({ kind: 'TagLimitReached' as const, max: Number(group.max_tags) });
        }
        const restored = restoreTag(value.data); if (!restored.ok) return restored;
        this.db.prepare('UPDATE tags SET archived=?,version=? WHERE id=? AND version=?').run(target, value.data.version, value.data.id, value.expectedVersion);
        this.db.prepare('UPDATE groups SET version=version+1 WHERE id=?').run(value.data.groupId);
        this.savedReceipt(key, value, `tag.${value.kind}.v1`, value.expectedVersion);
        return ok({ kind: target ? 'archived' as const : 'active' as const, tag: restored.value });
      });
    } catch { return err({ kind: 'RepositoryUnavailable' }); }
  }

}
