import { step } from '../framework/index.js';
import { validateCreate, checkUniqueCreate, checkQuota, createTag, validateUpdate, checkUniqueUpdate, updateTag } from './domain.js';
// Event behavior is data: domain ordering is explicit; execution and Result composition are not handwritten.
export const createTagEvent = {
  validate: step('validate-create', validateCreate),
  require: [step('check-unique-label', checkUniqueCreate), step('check-quota', checkQuota)] as const,
  evolve: step('create-tag', createTag),
};
export const updateTagEvent = {
  validate: step('validate-update', validateUpdate),
  require: [step('check-unique-label', checkUniqueUpdate)] as const,
  evolve: step('update-tag', updateTag),
};
