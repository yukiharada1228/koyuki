// Frozen comparison baseline: former hand-wired lifecycle, not the application API.
import { defineProgram, effect, next, ok, err, type Result, type Update } from '../framework/index.js';
import { createTagFeature } from '../tags/feature.js';
import type { TagRepository } from '../tags/repository.js';
import type { TagInput, UpdateInput, PersistedTag } from '../tags/domain.js';
type Feature = ReturnType<typeof createTagFeature>;
type Created = Awaited<ReturnType<Feature['createAction']>>;
type Updated = Awaited<ReturnType<Feature['updateAction']>>;
export type TagScreen =
  | { readonly kind: 'ready'; readonly tags: readonly PersistedTag[] }
  | { readonly kind: 'creating'; readonly tags: readonly PersistedTag[] }
  | { readonly kind: 'updating'; readonly tags: readonly PersistedTag[] }
  | { readonly kind: 'failed'; readonly tags: readonly PersistedTag[]; readonly error: { readonly kind: string } };
export type TagMessage =
  | { readonly type: 'create'; readonly input: TagInput }
  | { readonly type: 'update'; readonly input: UpdateInput }
  | { readonly type: 'created'; readonly result: Created }
  | { readonly type: 'updated'; readonly result: Updated }
  | { readonly type: 'dismiss' };
export interface TagPresentation {
  readonly title: string; readonly busy: boolean; readonly error: string | null;
  readonly rows: readonly { id: string; label: string; version: number }[];
  readonly actions: readonly ('create' | 'update' | 'dismiss')[];
}
export function tagView(state: TagScreen): TagPresentation {
  return { title: state.kind === 'creating' ? 'タグを作成中' : state.kind === 'updating' ? 'タグを更新中' : 'タグ管理',
    busy: state.kind === 'creating' || state.kind === 'updating', error: state.kind === 'failed' ? state.error.kind : null,
    rows: state.tags.map(tag => ({ id: tag.data.id, label: tag.data.label, version: tag.data.version })),
    actions: state.kind === 'creating' || state.kind === 'updating' ? [] : state.kind === 'failed' ? ['dismiss'] : ['create', 'update'] };
}
export function manualTagProgram(repository: TagRepository, initialTags: readonly PersistedTag[] = []) {
  const feature = createTagFeature(repository);
  const create = effect('tag.create', feature.createAction, (result): TagMessage => ({ type: 'created', result }));
  const update = effect('tag.update', feature.updateAction, (result): TagMessage => ({ type: 'updated', result }));
  return defineProgram({
    init: (): Update<TagScreen, TagMessage> => next({ kind: 'ready', tags: initialTags }),
    update(state: TagScreen, message: TagMessage): Result<Update<TagScreen, TagMessage>, { kind: 'UnexpectedMessage' }> {
      switch (state.kind) {
        case 'ready':
          if (message.type === 'create') return ok(next({ kind: 'creating', tags: state.tags }, create(message.input)));
          if (message.type === 'update') return ok(next({ kind: 'updating', tags: state.tags }, update(message.input)));
          break;
        case 'creating':
          if (message.type === 'created') return ok(message.result.ok
            ? next({ kind: 'ready', tags: [...state.tags, message.result.value] })
            : next({ kind: 'failed', tags: state.tags, error: message.result.error }));
          break;
        case 'updating':
          if (message.type === 'updated') {
            const result = message.result;
            return ok(result.ok
              ? next({ kind: 'ready', tags: state.tags.map(tag => tag.data.id === result.value.data.id ? result.value : tag) })
              : next({ kind: 'failed', tags: state.tags, error: result.error }));
          }
          break;
        case 'failed':
          if (message.type === 'dismiss') return ok(next({ kind: 'ready', tags: state.tags }));
          break;
      }
      return err({ kind: 'UnexpectedMessage' });
    },
    view: tagView,
  });
}
