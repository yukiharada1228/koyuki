import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTarget, transition, step, ok, err, type Result } from './framework/index.js';
import { tagModel } from './tags/model.js';
import { createTagEvent, updateTagEvent } from './tags/events.js';
import { Repository, type SaveError, type CreateLoadError } from './tags/repository.js';
import type { PersistedTag, ValidationError, DuplicateLabel, QuotaError, CreateCommand, ValidatedCreate } from './tags/domain.js';
const input = { groupId: 'g', label: 'A', icon: null };
test('registered model and event definitions do no IO until the event is handled', async () => {
  const repository = new Repository(), model = tagModel(repository);
  const create = model.creation.on(createTagEvent), update = model.revision.on(updateTagEvent);
  assert.deepEqual(repository.calls, []);
  const created = await create.run(input); assert(created.ok);
  const changed = await update.run({ ...input, id: created.value.data.id, label: 'B', expectedVersion: 1 }); assert(changed.ok);
  assert.equal(changed.value.data.label, 'B'); assert.equal(changed.value.data.version, 2);
  assert.deepEqual(repository.calls, ['load-create', 'save-created', 'load-update', 'save-updated']);
});
test('one target registration can attach different business policies without rewiring IO', async () => {
  const repository = new Repository(), model = tagModel(repository);
  const regular = model.creation.on(createTagEvent);
  const restricted = model.creation.on({
    ...createTagEvent,
    validate: step('validate-with-reserved-name', (command: CreateCommand): Result<ValidatedCreate, ValidationError | { kind: 'ReservedName' }> => command.input.label === 'reserved'
      ? err({ kind: 'ReservedName' as const }) : createTagEvent.validate.rule(command)),
  });
  const rejected = await restricted.run({ ...input, label: 'reserved' }); assert(!rejected.ok && rejected.error.kind === 'ReservedName');
  assert.deepEqual(repository.calls, ['load-create']);
  assert((await regular.run({ ...input, label: 'reserved' })).ok);
  assert.deepEqual(repository.calls, ['load-create', 'load-create', 'save-created']);
});
test('a pure transition composes independent typed stages without IO', () => {
  const result = transition(createTagEvent).inspect({ kind: 'create-unvalidated', input, snapshot: { newId: 't', groupId: 'g', version: 0, count: 0, max: 3, nextSortOrder: 0, existingLabels: [] } });
  assert(result.result.ok);
  assert.deepEqual(result.trace.map(t => t.step), ['validate-create', 'check-unique-label', 'check-quota', 'create-tag']);
});
test('validate/evolve convention supports no extra requirements and infers failures', async () => {
  const calls: string[] = [];
  const target = defineTarget({ operation: 'counter.update', load: async (n: number): Promise<Result<number, 'LoadError'>> => { calls.push('load'); return ok(n); }, save: async (n: string): Promise<Result<string, 'SaveError'>> => { calls.push('save'); return ok(n); } });
  const action = target.on({ validate: step('positive', (n: number): Result<number, 'Invalid'> => n > 0 ? ok(n) : err('Invalid')), require: [], evolve: step('string', (n: number) => ok(String(n))) });
  const typed: Result<string, 'LoadError' | 'SaveError' | 'Invalid'> = await action.run(4);
  assert.deepEqual(typed, ok('4')); assert.deepEqual(calls, ['load', 'save']);
  const stopped = await action.runDetailed(0); assert.deepEqual(stopped.result, err('Invalid')); assert.equal(stopped.plan, null);
  assert.deepEqual(calls, ['load', 'save', 'load']);
});
test('events stay independent of repository instances', async () => {
  const a = new Repository(), b = new Repository();
  const first = tagModel(a).creation.on(createTagEvent), second = tagModel(b).creation.on(createTagEvent);
  assert((await first.run(input)).ok); assert.deepEqual(b.calls, []);
  assert((await second.run(input)).ok); assert.equal(a.records.size, 1); assert.equal(b.records.size, 1);
});
test('public event action retains tag output and complete error union', async () => {
  const action = tagModel(new Repository()).creation.on(createTagEvent);
  const result: Result<PersistedTag, CreateLoadError | ValidationError | DuplicateLabel | QuotaError | SaveError> = await action.run(input);
  assert(result.ok);
  if (false) {
    // @ts-expect-error full failure union cannot be dropped
    const narrowed: Result<PersistedTag, SaveError> = await action.run(input);
    // @ts-expect-error registered target preserves request input type
    await action.run(123);
    void narrowed;
  }
});
function invalidDefinitions(repository: Repository) {
  const model = tagModel(repository);
  // @ts-expect-error update event cannot attach to a creation target
  model.creation.on(updateTagEvent);
  // @ts-expect-error evolve cannot skip unique and capacity proof states
  model.creation.on({ ...createTagEvent, require: [] });
  // @ts-expect-error domain requirements cannot be reversed
  model.creation.on({ ...createTagEvent, require: [createTagEvent.require[1], createTagEvent.require[0]] });
  // @ts-expect-error invalid adjacency is also rejected without a target
  transition({ ...createTagEvent, require: [createTagEvent.require[1]] });
  // @ts-expect-error update output cannot be saved to a creation target
  model.creation.on({ ...createTagEvent, evolve: updateTagEvent.evolve });
}
void invalidDefinitions;
