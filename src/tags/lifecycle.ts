import { ok, err, workflow, bindMutation, defineAction, type Result } from '../framework/index.js';
import type { PersistedTag, TagData, QuotaError } from './domain.js';
import type { UpdateLoadError, SaveError } from './repository.js';
declare const proof: unique symbol;
export interface LifecycleInput { readonly id: string; readonly expectedVersion: number }
interface LifecycleContext {
  readonly current: PersistedTag;
  readonly activeCount: number; readonly max: number;
}
export type LoadedActiveTag = Readonly<LifecycleContext & { kind: 'active' }>;
export type LoadedArchivedTag = Readonly<LifecycleContext & { kind: 'archived' }>;
export type LifecycleCommand = LoadedActiveTag | LoadedArchivedTag;
export type ActiveTag = LoadedActiveTag & { readonly [proof]: 'active' };
export type ArchivedTag = LoadedArchivedTag & { readonly [proof]: 'archived' };
export type RestorableTag = LoadedArchivedTag & { readonly [proof]: 'restorable' };
export type LifecycleError = { kind: 'AlreadyArchived' } | { kind: 'NotArchived' };
export type ArchiveChange = Readonly<{ kind: 'archive'; data: TagData; expectedVersion: number }> & { readonly [proof]: 'archive-change' };
export type RestoreChange = Readonly<{ kind: 'restore'; data: TagData; expectedVersion: number }> & { readonly [proof]: 'restore-change' };
export type LifecycleChange = ArchiveChange | RestoreChange;
export type LifecycleSaved = { readonly kind: 'active'; readonly tag: PersistedTag } | { readonly kind: 'archived'; readonly tag: PersistedTag };
export interface LifecycleRepository {
  loadLifecycle(input: LifecycleInput): Promise<Result<LifecycleCommand, UpdateLoadError>>;
  saveLifecycle(value: LifecycleChange): Promise<Result<LifecycleSaved, SaveError | QuotaError>>;
}
export function requireActive(command: LifecycleCommand): Result<ActiveTag, { kind: 'AlreadyArchived' }> {
  return command.kind === 'archived' ? err({ kind: 'AlreadyArchived' }) : ok(Object.freeze({ ...command }) as ActiveTag);
}
export function archiveTag(command: ActiveTag): Result<ArchiveChange, never> {
  return ok(Object.freeze({ kind: 'archive', expectedVersion: command.current.data.version,
    data: Object.freeze({ ...command.current.data, version: command.current.data.version + 1 }) }) as ArchiveChange);
}
export function requireArchived(command: LifecycleCommand): Result<ArchivedTag, { kind: 'NotArchived' }> {
  return command.kind === 'archived' ? ok(Object.freeze({ ...command }) as ArchivedTag) : err({ kind: 'NotArchived' });
}
export function checkRestoreCapacity(command: ArchivedTag): Result<RestorableTag, QuotaError> {
  return command.activeCount >= command.max ? err({ kind: 'TagLimitReached', max: command.max })
    : ok(Object.freeze({ kind: command.kind, current: command.current, activeCount: command.activeCount, max: command.max }) as RestorableTag);
}
export function restoreArchivedTag(command: RestorableTag): Result<RestoreChange, never> {
  return ok(Object.freeze({ kind: 'restore', expectedVersion: command.current.data.version,
    data: Object.freeze({ ...command.current.data, version: command.current.data.version + 1 }) }) as RestoreChange);
}
export const archiveWorkflow = workflow('require-active', requireActive).then('archive-tag', archiveTag);
export const restoreWorkflow = workflow('require-archived', requireArchived)
  .then('check-restore-capacity', checkRestoreCapacity).then('restore-tag', restoreArchivedTag);
export function createLifecycleFeature(repository: LifecycleRepository) {
  const archive = bindMutation({ workflow: archiveWorkflow, operation: 'tag.archive.v1', save: async (value: ArchiveChange) => {
    const result = await repository.saveLifecycle(value); if (!result.ok) return result;
    if (result.value.kind !== 'archived') throw new Error('UnexpectedArchiveResult');
    return ok(result.value);
  } });
  const restore = bindMutation({ workflow: restoreWorkflow, operation: 'tag.restore.v1', save: async (value: RestoreChange) => {
    const result = await repository.saveLifecycle(value); if (!result.ok) return result;
    if (result.value.kind !== 'active') throw new Error('UnexpectedRestoreResult');
    return ok(result.value);
  } });
  return {
    archive: defineAction({ loadName: 'load-tag', load: (input: LifecycleInput) => repository.loadLifecycle(input), mutation: archive }),
    restore: defineAction({ loadName: 'load-tag', load: (input: LifecycleInput) => repository.loadLifecycle(input), mutation: restore }),
    archiveMutation: archive, restoreMutation: restore,
  };
}
