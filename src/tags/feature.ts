import { transition } from '../framework/index.js';
import { Done, type View } from '../framework/experimental-jsx.js';
import type { CreatedTag, UpdatedTag, PersistedTag } from './domain.js';
import type { TagRepository } from './repository.js';
import { tagModel } from './model.js';
import { createTagEvent, updateTagEvent } from './events.js';
// Compatibility exports for pure decision tests and the manual-composition baseline.
export const createWorkflow = transition(createTagEvent);
export const updateWorkflow = transition(updateTagEvent);
export function createTagFeature(repository: TagRepository) {
  const tags = tagModel(repository);
  const createCommand = tags.creation.on(createTagEvent);
  const updateCommand = tags.revision.on(updateTagEvent);
  const create = createCommand.mutation, update = updateCommand.mutation;
  function TagProcess({ state }: { state: CreatedTag | UpdatedTag | PersistedTag }): View {
    switch (state.kind) {
      case 'created': return create.Save({ value: state });
      case 'updated': return update.Save({ value: state });
      case 'persisted': return Done();
    }
  }
  return { create, update, TagProcess, createAction: createCommand.run, updateAction: updateCommand.run,
    createDetailed: createCommand.runDetailed, updateDetailed: updateCommand.runDetailed };
}
