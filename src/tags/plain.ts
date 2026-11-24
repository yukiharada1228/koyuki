import { compose } from '../core.js';
import { validateCreate, checkUniqueCreate, checkQuota, createTag, validateUpdate, checkUniqueUpdate, updateTag, type CreateCommand, type UpdateCommand, type TagInput, type UpdateInput } from './domain.js';
import type { TagRepository } from './repository.js';
// Plain TS + Result, with exactly the same rules and adapters as the framework version.
export function createPlain(command: CreateCommand) {
  const validated = validateCreate(command);
  if (!validated.ok) return validated;
  const unique = checkUniqueCreate(validated.value);
  if (!unique.ok) return unique;
  const allowed = checkQuota(unique.value);
  if (!allowed.ok) return allowed;
  return createTag(allowed.value);
}
export function updatePlain(command: UpdateCommand) {
  const validated = validateUpdate(command);
  if (!validated.ok) return validated;
  const unique = checkUniqueUpdate(validated.value);
  if (!unique.ok) return unique;
  return updateTag(unique.value);
}
export async function createActionPlain(repository: TagRepository, input: TagInput) {
  const loaded = await repository.loadCreate(input);
  if (!loaded.ok) return loaded;
  const decided = createPlain(loaded.value);
  if (!decided.ok) return decided;
  return repository.saveCreated(decided.value);
}
export async function updateActionPlain(repository: TagRepository, input: UpdateInput) {
  const loaded = await repository.loadUpdate(input);
  if (!loaded.ok) return loaded;
  const decided = updatePlain(loaded.value);
  if (!decided.ok) return decided;
  return repository.saveUpdated(decided.value);
}

// A reusable composition helper is a fairer baseline than duplicated error checks.
export const createComposed = compose(compose(compose(validateCreate, checkUniqueCreate), checkQuota), createTag);
export const updateComposed = compose(compose(validateUpdate, checkUniqueUpdate), updateTag);
