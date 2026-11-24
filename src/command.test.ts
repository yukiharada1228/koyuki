import { validateCreate, checkUniqueCreate, checkQuota, createTag, validateUpdate, checkUniqueUpdate, updateTag } from './tags/domain.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineCommand, defineAction, bindMutation, workflow, ok, err, type Result } from './framework/index.js';
import { createTagFeature, createWorkflow, updateWorkflow } from './tags/feature.js';
import { Repository, type SaveError, type CreateLoadError } from './tags/repository.js';
import type { CreatedTag, UpdatedTag, PersistedTag, TagInput, ValidationError, DuplicateLabel, QuotaError } from './tags/domain.js';
const input = (label: string): TagInput => ({ groupId: 'g', label, icon: null });
function oldFeature(repository: Repository) {
  const createWorkflow = workflow('validate-create', validateCreate).then('check-unique-label', checkUniqueCreate).then('check-quota', checkQuota).then('create-tag', createTag);
  const updateWorkflow = workflow('validate-update', validateUpdate).then('check-unique-label', checkUniqueUpdate).then('update-tag', updateTag);
  const create = bindMutation({ workflow: createWorkflow, operation: 'tag.create.v1', save: repository.saveCreated.bind(repository) });
  const update = bindMutation({ workflow: updateWorkflow, operation: 'tag.update.v1', save: repository.saveUpdated.bind(repository) });
  return {
    create: defineAction({ loadName: 'load-create', load: repository.loadCreate.bind(repository), mutation: create }),
    update: defineAction({ loadName: 'load-update', load: repository.loadUpdate.bind(repository), mutation: update }),
  };
}
test('tag definitions preserve results, traces, plans, and adapter calls from manual wiring', async () => {
  const a = new Repository(), b = new Repository(), before = oldFeature(a), after = createTagFeature(b);
  for (const value of [input('A'), input('B'), input(' A '), input(''), input('C'), input('D')]) {
    assert.deepEqual(await after.createDetailed(value), await before.create.runDetailed(value));
  }
  for (const value of [
    { ...input('Renamed'), id: 'tag-1', expectedVersion: 1 },
    { ...input('Other'), id: 'tag-1', expectedVersion: 1 },
    { ...input('B'), id: 'tag-1', expectedVersion: 2 },
    { ...input('Missing'), id: 'missing' },
  ]) assert.deepEqual(await after.updateDetailed(value), await before.update.runDetailed(value));
  assert.deepEqual(a.calls, b.calls); assert.deepEqual(a.records, b.records);
});
function command(fail: 'load' | 'decide' | 'save' | 'none', calls: string[]) {
  return defineCommand({
    operation: 'test.save',
    load: async (input: number): Promise<Result<number, 'LoadFailed'>> => { calls.push('load'); return fail === 'load' ? err('LoadFailed') : ok(input); },
    decide: workflow('validate', (value: number): Result<number, 'DecisionFailed'> => { calls.push('decide'); return fail === 'decide' ? err('DecisionFailed') : ok(value + 1); }),
    save: async (value: number): Promise<Result<string, 'SaveFailed'>> => { calls.push('save'); return fail === 'save' ? err('SaveFailed') : ok(String(value)); },
  });
}
for (const [phase, callsExpected, resultExpected] of [
  ['none', ['load', 'decide', 'save'], ok('3')],
  ['load', ['load'], err('LoadFailed')],
  ['decide', ['load', 'decide'], err('DecisionFailed')],
  ['save', ['load', 'decide', 'save'], err('SaveFailed')],
] as const) {
  test(`command ${phase}: convention executes phases once, stops on failure`, async () => {
    const calls: string[] = [], action = command(phase, calls);
    assert.deepEqual(calls, []);
    const result = await action.runDetailed(2);
    assert.deepEqual(calls, callsExpected); assert.deepEqual(result.result, resultExpected);
    assert.equal(result.trace[0]?.step, 'test.save:load');
    if (phase === 'load' || phase === 'decide') assert.equal(result.plan, null);
  });
}
test('command errors retain all phases; repeated run is not a retry or idempotency guarantee', async () => {
  const calls: string[] = [], action = command('none', calls);
  const result: Result<string, 'LoadFailed' | 'DecisionFailed' | 'SaveFailed'> = await action.run(2);
  assert.deepEqual(result, ok('3')); await action.run(2);
  assert.deepEqual(calls, ['load', 'decide', 'save', 'load', 'decide', 'save']);
  if (false) {
    // @ts-expect-error loader and decision errors cannot be discarded
    const missingErrors: Result<string, 'SaveFailed'> = await action.run(2);
    // @ts-expect-error public command input remains number
    await action.run('2');
    void missingErrors;
  }
});
test('unexpected adapter exceptions remain visible', async () => {
  const action = defineCommand({ operation: 'bad', load: async (_: number) => { throw new Error('unexpected'); }, decide: workflow('number', (n: number) => ok(n)), save: async (n: number) => ok(n) });
  await assert.rejects(action.run(1), /unexpected/);
});
test('tag command result stays precise without generic arguments or error enumeration at definition', async () => {
  const f = createTagFeature(new Repository());
  const result: Result<PersistedTag, CreateLoadError | ValidationError | DuplicateLabel | QuotaError | SaveError> = await f.createAction(input('A'));
  assert(result.ok);
});
function typeChecks(repository: Repository) {
  defineCommand({ operation: 'wrong-save', load: (input: TagInput) => repository.loadCreate(input), decide: createWorkflow,
    // @ts-expect-error update adapter cannot save a create decision
    save: (value: UpdatedTag) => repository.saveUpdated(value),
  });
  defineCommand({ operation: 'wrong-rule',
    // @ts-expect-error loaded number is not a create command
    load: async (_: TagInput) => ok(123),
    decide: createWorkflow, save: (value: CreatedTag) => repository.saveCreated(value),
  });
}
void typeChecks;
