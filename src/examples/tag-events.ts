import { Repository } from '../tags/repository.js';
import { tagModel } from '../tags/model.js';
import { createTagEvent, updateTagEvent } from '../tags/events.js';
const repository = new Repository();
const tags = tagModel(repository);
const create = tags.creation.on(createTagEvent);
const update = tags.revision.on(updateTagEvent);
const input = { groupId: 'g', label: 'VIP', icon: null };
const created = await create.runDetailed(input);
console.log(JSON.stringify({ event: 'create', ...created }, null, 2));
if (created.result.ok) {
  console.log(JSON.stringify({ event: 'update', ...await update.runDetailed({
    ...input, id: created.result.value.data.id, expectedVersion: 1, label: 'Regular',
  }) }, null, 2));
}
console.log(JSON.stringify({ event: 'invalid-create', ...await create.runDetailed({ ...input, label: '' }) }, null, 2));
console.log(JSON.stringify({ calls: repository.calls }, null, 2));
