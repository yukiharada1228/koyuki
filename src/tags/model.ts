import { defineTarget } from '../framework/index.js';
import type { TagRepository } from './repository.js';
// IO registration belongs to the model boundary, once per persistence operation.
export function tagModel(repository: TagRepository) {
  return {
    creation: defineTarget({ operation: 'tag.create.v1', loadName: 'load-create',
      load: repository.loadCreate.bind(repository), save: repository.saveCreated.bind(repository) }),
    revision: defineTarget({ operation: 'tag.update.v1', loadName: 'load-update',
      load: repository.loadUpdate.bind(repository), save: repository.saveUpdated.bind(repository) }),
  };
}
