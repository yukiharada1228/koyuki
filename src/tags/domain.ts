import { ok, err, type Result } from '../framework/result.js';
// Private brands: only validated constructors in this module mint these states.
declare const labelBrand: unique symbol;
declare const stateBrand: unique symbol;
export type TagLabel = string & { readonly [labelBrand]: true };
export type Icon = Readonly<{ symbol: string; color: string | null }> | null;
export type TagInput = Readonly<{ groupId: string; label: unknown; icon: unknown }>;
export type UpdateInput = TagInput & Readonly<{ id: string; expectedVersion?: number }>;
export type ValidationError = Readonly<{ kind: 'ValidationError'; fields: readonly string[] }>;
export type DuplicateLabel = Readonly<{ kind: 'DuplicateLabel'; label: string }>;
export const normalizeLabel = (label: string): string => label.trim().normalize('NFC');
export type QuotaError = Readonly<{ kind: 'TagLimitReached'; max: number }>;
export type TargetError = Readonly<{ kind: 'TargetMismatch' }>;
export type CorruptError = Readonly<{ kind: 'CorruptStoredTag' }>;
export interface RawTag { id: string; groupId: string; label: string; icon: Icon; sortOrder: number; version: number }
export type TagData = Readonly<Omit<RawTag, 'label'> & { label: TagLabel }>;
type Opaque<K extends string> = { readonly [stateBrand]: K };
export type PersistedTag = Readonly<{ kind: 'persisted'; data: TagData }> & Opaque<'persisted'>;
export interface Snapshot { newId: string; groupId: string; version: number; count: number; max: number; nextSortOrder: number; existingLabels: readonly string[] }
export type CreateCommand = Readonly<{ kind: 'create-unvalidated'; input: TagInput; snapshot: Readonly<Snapshot> }>;
export type ValidatedCreate = Readonly<{ kind: 'create-validated'; fields: Fields; snapshot: Readonly<Snapshot> }> & Opaque<'create-validated'>;
export type UniqueCreate = Readonly<{ kind: 'create-unique'; fields: Fields; snapshot: Readonly<Snapshot> }> & Opaque<'create-unique'>;
export type AllowedCreate = Readonly<{ kind: 'create-allowed'; fields: Fields; snapshot: Readonly<Snapshot> }> & Opaque<'create-allowed'>;
export type CreatedTag = Readonly<{ kind: 'created'; data: TagData; expectedGroupVersion: number }> & Opaque<'created'>;
export type UpdateCommand = Readonly<{ kind: 'update-unvalidated'; input: UpdateInput; current: PersistedTag; existingLabels: readonly string[] }>;
export type ValidatedUpdate = Readonly<{ kind: 'update-validated'; fields: Fields; current: PersistedTag; existingLabels: readonly string[] }> & Opaque<'update-validated'>;
export type UniqueUpdate = Readonly<{ kind: 'update-unique'; fields: Fields; current: PersistedTag }> & Opaque<'update-unique'>;
export type UpdatedTag = Readonly<{ kind: 'updated'; data: TagData; expectedVersion: number }> & Opaque<'updated'>;
export type TagState = CreateCommand | ValidatedCreate | UniqueCreate | AllowedCreate | CreatedTag | UpdateCommand | ValidatedUpdate | UniqueUpdate | UpdatedTag | PersistedTag;
type Fields = Readonly<{ groupId: string; label: TagLabel; icon: Icon }>;
function parseFields(input: { groupId: unknown; label: unknown; icon: unknown }): Result<Fields, ValidationError> {
  const fields: string[] = [];
  if (typeof input.groupId !== 'string' || !input.groupId.trim()) fields.push('groupId');
  if (typeof input.label !== 'string' || !input.label.trim() || [...input.label.trim()].length > 30) fields.push('label');
  let icon: Icon = null;
  if (input.icon !== null) {
    if (typeof input.icon !== 'object' || input.icon === null) fields.push('icon');
    else {
      const value = input.icon as Record<string, unknown>;
      if (typeof value.symbol !== 'string' || !value.symbol.trim() || [...value.symbol].length > 8) fields.push('icon.symbol');
      if (value.color !== null && (typeof value.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.color))) fields.push('icon.color');
      if (!fields.some(field => field.startsWith('icon'))) icon = Object.freeze({ symbol: value.symbol as string, color: value.color as string | null });
    }
  }
  if (fields.length) return err(Object.freeze({ kind: 'ValidationError', fields: Object.freeze(fields) }));
  return ok(Object.freeze({ groupId: input.groupId as string, label: normalizeLabel(input.label as string) as TagLabel, icon }));
}
function data(value: TagData): TagData { return Object.freeze(value); }
export function validateCreate(command: CreateCommand): Result<ValidatedCreate, ValidationError> {
  const parsed = parseFields(command.input); if (!parsed.ok) return parsed;
  const s = command.snapshot;
  if (!s.newId || s.groupId !== parsed.value.groupId || !Number.isSafeInteger(s.version) || s.version < 0 ||
    !Number.isSafeInteger(s.count) || s.count < 0 || !Number.isSafeInteger(s.max) || s.max <= 0 ||
    !Array.isArray(s.existingLabels) || !s.existingLabels.every(label => typeof label === 'string') || !Number.isSafeInteger(s.nextSortOrder) || s.nextSortOrder < 0) return err({ kind: 'ValidationError', fields: ['snapshot'] });
  return ok(Object.freeze({ kind: 'create-validated', fields: parsed.value, snapshot: Object.freeze({ ...s, existingLabels: Object.freeze([...s.existingLabels]) }) }) as ValidatedCreate);
}
export function checkUniqueCreate(tag: ValidatedCreate): Result<UniqueCreate, DuplicateLabel> {
  return tag.snapshot.existingLabels.some(label => normalizeLabel(label) === tag.fields.label)
    ? err({ kind: 'DuplicateLabel', label: tag.fields.label })
    : ok(Object.freeze({ kind: 'create-unique', fields: tag.fields, snapshot: tag.snapshot }) as UniqueCreate);
}
export function checkQuota(tag: UniqueCreate): Result<AllowedCreate, QuotaError> {
  return tag.snapshot.count >= tag.snapshot.max ? err({ kind: 'TagLimitReached', max: tag.snapshot.max })
    : ok(Object.freeze({ kind: 'create-allowed', fields: tag.fields, snapshot: tag.snapshot }) as AllowedCreate);
}
export function createTag(tag: AllowedCreate): Result<CreatedTag, never> {
  return ok(Object.freeze({ kind: 'created', expectedGroupVersion: tag.snapshot.version,
    data: data({ ...tag.fields, id: tag.snapshot.newId, sortOrder: tag.snapshot.nextSortOrder, version: 1 }) }) as CreatedTag);
}
export function restoreTag(raw: unknown): Result<PersistedTag, CorruptError> {
  if (typeof raw !== 'object' || raw === null) return err({ kind: 'CorruptStoredTag' });
  const value = raw as Record<string, unknown>;
  const fields = parseFields({ groupId: value.groupId, label: value.label, icon: value.icon });
  if (!fields.ok || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
    !Number.isSafeInteger(value.sortOrder) || (value.sortOrder as number) < 0) return err({ kind: 'CorruptStoredTag' });
  return ok(Object.freeze({ kind: 'persisted', data: data({ ...fields.value, id: value.id, version: value.version as number, sortOrder: value.sortOrder as number }) }) as PersistedTag);
}
export function validateUpdate(command: UpdateCommand): Result<ValidatedUpdate, ValidationError | TargetError> {
  const fields = parseFields(command.input); if (!fields.ok) return fields;
  if (command.current.data.id !== command.input.id || command.current.data.groupId !== fields.value.groupId) return err({ kind: 'TargetMismatch' });
  return ok(Object.freeze({ kind: 'update-validated', fields: fields.value, current: command.current, existingLabels: Object.freeze([...command.existingLabels]) }) as ValidatedUpdate);
}
export function checkUniqueUpdate(command: ValidatedUpdate): Result<UniqueUpdate, DuplicateLabel> {
  return command.existingLabels.some(label => normalizeLabel(label) === command.fields.label)
    ? err({ kind: 'DuplicateLabel', label: command.fields.label })
    : ok(Object.freeze({ kind: 'update-unique', fields: command.fields, current: command.current }) as UniqueUpdate);
}
export function updateTag(command: UniqueUpdate): Result<UpdatedTag, never> {
  return ok(Object.freeze({ kind: 'updated', expectedVersion: command.current.data.version,
    data: data({ ...command.current.data, ...command.fields, version: command.current.data.version + 1 }) }) as UpdatedTag);
}
