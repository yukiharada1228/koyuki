import { defineApplication, operation, type ApplicationState, type ApplicationEvent } from '../framework/index.js';
import { tagModel } from './model.js';
import { createTagEvent, updateTagEvent } from './events.js';
import type { TagRepository } from './repository.js';
import type { PersistedTag } from './domain.js';
// Only the business meaning of a successful result is defined here.
export function tagOperations(repository: TagRepository) {
  const tags = tagModel(repository);
  return {
    create: operation(tags.creation.on(createTagEvent), (state: readonly PersistedTag[], tag) => [...state, tag]),
    update: operation(tags.revision.on(updateTagEvent), (state: readonly PersistedTag[], tag) => state.map(current => current.data.id === tag.data.id ? tag : current)),
  };
}
type Operations = ReturnType<typeof tagOperations>;
export type TagScreen = ApplicationState<readonly PersistedTag[], Operations>;
export type TagMessage = ApplicationEvent<Operations>;
export interface TagPresentation {
  readonly title: string; readonly busy: boolean; readonly error: string | null;
  readonly rows: readonly { id: string; label: string; version: number }[];
  readonly actions: readonly ('create' | 'update' | 'dismiss')[];
}
export function tagView(state: TagScreen): TagPresentation {
  return { title: state.kind === 'running' ? state.operation === 'create' ? 'タグを作成中' : 'タグを更新中' : 'タグ管理',
    busy: state.kind === 'running', error: state.kind === 'failed' ? state.error.kind : null,
    rows: state.data.map(tag => ({ id: tag.data.id, label: tag.data.label, version: tag.data.version })),
    actions: state.kind === 'running' ? [] : state.kind === 'failed' ? ['dismiss'] : ['create', 'update'] };
}
export function tagProgram(repository: TagRepository, initialTags: readonly PersistedTag[] = []) {
  return defineApplication({ initial: () => initialTags, operations: tagOperations(repository), view: tagView });
}
