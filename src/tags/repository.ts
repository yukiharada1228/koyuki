import { ok, err, type Result } from '../framework/result.js';
import { fingerprint } from '../framework/identity.js';
import { restoreTag, normalizeLabel, type DuplicateLabel, type RawTag, type TagInput, type UpdateInput, type CreateCommand, type UpdateCommand, type CreatedTag, type UpdatedTag, type PersistedTag, type CorruptError } from './domain.js';
export type CreateLoadError = { kind: 'GroupNotFound' } | { kind: 'RepositoryUnavailable' } | CorruptError;
export type UpdateLoadError = { kind: 'TagArchived' } | { kind: 'SaveConflict' } | { kind: 'NotFound' } | { kind: 'RepositoryUnavailable' } | CorruptError;
export type LoadError = CreateLoadError | UpdateLoadError;
export type SaveError = DuplicateLabel | { kind: 'SaveConflict' } | { kind: 'RepositoryUnavailable' } | CorruptError;
export interface TagRepository {
  loadCreate(input: TagInput): Promise<Result<CreateCommand, CreateLoadError>>;
  loadUpdate(input: UpdateInput): Promise<Result<UpdateCommand, UpdateLoadError>>;
  saveCreated(value: CreatedTag): Promise<Result<PersistedTag, SaveError>>;
  saveUpdated(value: UpdatedTag): Promise<Result<PersistedTag, SaveError>>;
}
export class Repository implements TagRepository {
  readonly records = new Map<string, unknown>();
  readonly calls: string[] = [];
  private readonly groups = new Map<string, { version: number; max: number }>([['g', { version: 0, max: 3 }]]);
  private readonly createReceipts = new Map<string, string>();
  private readonly updateReceipts = new Map<string, string>();
  private nextId = 1;
  unavailable = false;
  failSave = false;
  async loadCreate(input: TagInput): Promise<Result<CreateCommand, CreateLoadError>> {
    this.calls.push('load-create'); if (this.unavailable) return err({ kind: 'RepositoryUnavailable' });
    const group = this.groups.get(input.groupId); if (!group) return err({ kind: 'GroupNotFound' });
    const rows = [...this.records.values()].filter((r): r is RawTag => typeof r === 'object' && r !== null && 'groupId' in r && r.groupId === input.groupId);
    // Read-side boundary restores/validates the relevant stored records.
    const restored = rows.map(restoreTag); if (restored.some(row => !row.ok)) return err({ kind: 'CorruptStoredTag' });
    const orders = restored.flatMap(row => row.ok ? [row.value.data.sortOrder] : []);
    return ok({ kind: 'create-unvalidated', input: structuredClone(input), snapshot: { newId: `tag-${this.nextId++}`, groupId: input.groupId,
      version: group.version, count: rows.length, max: group.max, existingLabels: restored.flatMap(row => row.ok ? [row.value.data.label] : []), nextSortOrder: orders.length ? Math.max(...orders) + 1 : 0 } });
  }
  async loadUpdate(input: UpdateInput): Promise<Result<UpdateCommand, UpdateLoadError>> {
    this.calls.push('load-update'); if (this.unavailable) return err({ kind: 'RepositoryUnavailable' });
    const raw = this.records.get(input.id); if (!raw) return err({ kind: 'NotFound' });
    const restored = restoreTag(raw); if (!restored.ok) return restored;
    if (input.expectedVersion !== undefined && input.expectedVersion !== restored.value.data.version) return err({ kind: 'SaveConflict' });
    const peers = [...this.records.entries()].filter(([id, row]) => id !== input.id && typeof row === 'object' && row !== null && 'groupId' in row && row.groupId === restored.value.data.groupId).map(([, row]) => restoreTag(row));
    if (peers.some(row => !row.ok)) return err({ kind: 'CorruptStoredTag' });
    return ok({ kind: 'update-unvalidated', input: structuredClone(input), current: restored.value, existingLabels: peers.flatMap(row => row.ok ? [row.value.data.label] : []) });
  }
  async saveCreated(value: CreatedTag): Promise<Result<PersistedTag, SaveError>> {
    this.calls.push('save-created'); if (this.failSave) return err({ kind: 'RepositoryUnavailable' });
    const receipt = this.createReceipts.get(value.data.id);
    if (receipt) {
      if (receipt !== fingerprint(value)) return err({ kind: 'SaveConflict' });
      const current = restoreTag(this.records.get(value.data.id));
      if (!current.ok) return current;
      return fingerprint(current.value.data) === fingerprint(value.data) ? current : err({ kind: 'SaveConflict' });
    }
    const group = this.groups.get(value.data.groupId);
    if (!group || group.version !== value.expectedGroupVersion || this.records.has(value.data.id)) return err({ kind: 'SaveConflict' });
    if ([...this.records.values()].some(row => typeof row === 'object' && row !== null && 'groupId' in row && row.groupId === value.data.groupId && 'label' in row && typeof row.label === 'string' && normalizeLabel(row.label) === value.data.label)) return err({ kind: 'DuplicateLabel', label: value.data.label });
    const count = [...this.records.values()].filter(row => typeof row === 'object' && row !== null && 'groupId' in row && row.groupId === value.data.groupId).length;
    if (count >= group.max || value.data.version !== 1) return err({ kind: 'SaveConflict' });
    const restored = restoreTag(value.data); if (!restored.ok) return restored;
    // One synchronous critical section models one DB transaction in this experiment.
    this.records.set(value.data.id, structuredClone(value.data)); group.version++;
    this.createReceipts.set(value.data.id, fingerprint(value)); return restored;
  }
  async saveUpdated(value: UpdatedTag): Promise<Result<PersistedTag, SaveError>> {
    this.calls.push('save-updated'); if (this.failSave) return err({ kind: 'RepositoryUnavailable' });
    const receiptKey = `${value.data.id}:${value.expectedVersion}`;
    const previous = this.updateReceipts.get(receiptKey);
    if (previous && previous !== fingerprint(value)) return err({ kind: 'SaveConflict' });
    const current = restoreTag(this.records.get(value.data.id));
    if (!current.ok) return this.records.has(value.data.id) ? current : err({ kind: 'SaveConflict' });
    if (previous) {
      // Do not replay an old success as if it were the latest entity after later updates.
      if (current.value.data.version !== value.data.version || fingerprint(current.value.data) !== fingerprint(value.data)) return err({ kind: 'SaveConflict' });
      return current;
    }
    if (current.value.data.version !== value.expectedVersion || current.value.data.groupId !== value.data.groupId) return err({ kind: 'SaveConflict' });
    if ([...this.records.entries()].some(([id, row]) => id !== value.data.id && typeof row === 'object' && row !== null && 'groupId' in row && row.groupId === value.data.groupId && 'label' in row && typeof row.label === 'string' && normalizeLabel(row.label) === value.data.label)) return err({ kind: 'DuplicateLabel', label: value.data.label });
    const restored = restoreTag(value.data); if (!restored.ok) return restored;
    this.records.set(value.data.id, structuredClone(value.data));
    this.updateReceipts.set(receiptKey, fingerprint(value)); return restored;
  }
}
