// The consumer attaches pure event behavior to a registered model target.
import { tagModel } from '../tags/model.js';
import { createTagEvent } from '../tags/events.js';
import type { TagRepository } from '../tags/repository.js';
export function createTagAction(repository: TagRepository) {
  return tagModel(repository).creation.on(createTagEvent);
}
