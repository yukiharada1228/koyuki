import { Repository } from './repository.js';
import { createTagFeature } from './feature.js';
import { createActionPlain, updateActionPlain } from './plain.js';
import { describeView } from './workflow.js';
const input = { groupId: 'g', label: ' VIP ', icon: { symbol: '★', color: '#AABBCC' } };
for (const mode of ['plain', 'framework'] as const) {
  const repository = new Repository(), feature = createTagFeature(repository);
  const created = mode === 'plain' ? await createActionPlain(repository, input) : await feature.createAction(input);
  if (!created.ok) throw new Error('UnexpectedCreateFailure');
  const update = { ...input, id: created.value.data.id, label: 'Regular', icon: null };
  const updated = mode === 'plain' ? await updateActionPlain(repository, update) : await feature.updateAction(update);
  console.log(JSON.stringify({ mode, created, updated, io: repository.calls }, null, 2));
}
const repository = new Repository(), feature = createTagFeature(repository);
const loaded = await repository.loadCreate(input); if (!loaded.ok) throw new Error('UnexpectedLoadFailure');
const prepared = feature.create.prepare(loaded.value);
if (!prepared.result.ok) throw new Error('UnexpectedDecisionFailure');
console.log(JSON.stringify({ mode: 'framework/dry-run', prepared, plan: describeView(feature.create.view(prepared.result.value)), io: repository.calls }, null, 2));
const limit = feature.create.prepare({ ...loaded.value, snapshot: { ...loaded.value.snapshot, count: 3 } });
console.log(JSON.stringify({ mode: 'framework/quota-failure', prepared: limit }, null, 2));
