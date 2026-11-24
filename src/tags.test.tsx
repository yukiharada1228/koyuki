/** @jsx ht */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, type Result } from './core.js';
import { Repository, type SaveError, type CreateLoadError } from './tags/repository.js';
import { createPlain, updatePlain, createComposed, updateComposed, createActionPlain, updateActionPlain } from './tags/plain.js';
import { createTagFeature, createWorkflow, updateWorkflow } from './tags/feature.js';
import { validateCreate, createTag, updateTag, restoreTag, type CreateCommand, type CreatedTag, type UpdatedTag, type PersistedTag, type ValidationError, type QuotaError, type DuplicateLabel, type TagInput, type UpdateInput } from './tags/domain.js';
import { workflow, bindMutation, describeView, Mutation, Done, ht, type Workflow, type View } from './tags/workflow.js';
const input: TagInput = { groupId: 'g', label: ' VIP ', icon: { symbol: '★', color: '#AABBCC' } };
const raw = (id = 'original') => ({ id, groupId: 'g', label: 'Old', icon: null, sortOrder: 7, version: 1 });
type Mode = 'plain' | 'framework';
function fixture(mode: Mode) {
  const repository = new Repository(), feature = createTagFeature(repository);
  return { repository, feature,
    create: (value: TagInput = input) => mode === 'plain' ? createActionPlain(repository, value) : feature.createAction(value),
    update: (value: UpdateInput) => mode === 'plain' ? updateActionPlain(repository, value) : feature.updateAction(value),
    decideCreate: mode === 'plain' ? createPlain : createWorkflow.run.bind(createWorkflow),
    decideUpdate: mode === 'plain' ? updatePlain : updateWorkflow.run.bind(updateWorkflow),
  };
}
function command(overrides: Partial<CreateCommand['snapshot']> = {}): CreateCommand {
  return { kind: 'create-unvalidated', input, snapshot: { newId: 'new-id', groupId: 'g', version: 0, count: 0, max: 3, nextSortOrder: 0, existingLabels: [], ...overrides } };
}
for (const mode of ['plain', 'framework'] as const) {
  test(`tags/${mode}: create advances input to persisted data with id and sort order`, async () => {
    const f = fixture(mode), result = await f.create(); assert(result.ok);
    assert.equal(result.value.kind, 'persisted'); assert.equal(result.value.data.label, 'VIP');
    assert.equal(result.value.data.id, 'tag-1'); assert.equal(result.value.data.sortOrder, 0);
    assert.equal(result.value.data.version, 1); assert.deepEqual(result.value.data.icon, input.icon);
    assert.deepEqual(f.repository.calls, ['load-create', 'save-created']);
  });
  test(`tags/${mode}: validation collects independent failures and prevents saving`, async () => {
    const f = fixture(mode);
    const result = await f.create({ groupId: 'g', label: '', icon: { symbol: '', color: 'red' } });
    assert.deepEqual(result, { ok: false, error: { kind: 'ValidationError', fields: ['label', 'icon.symbol', 'icon.color'] } });
    assert.deepEqual(f.repository.calls, ['load-create']); assert.equal(f.repository.records.size, 0);
  });
  test(`tags/${mode}: input shapes and label length are checked at runtime`, async () => {
    const f = fixture(mode);
    for (const label of [undefined, 42, ' ', 'a'.repeat(31)]) {
      const result = await f.create({ groupId: 'g', label, icon: null });
      assert(!result.ok && result.error.kind === 'ValidationError');
    }
    assert.equal(f.repository.records.size, 0);
  });
  test(`tags/${mode}: quota failure prevents creation and save`, async () => {
    const f = fixture(mode);
    for (let i = 0; i < 3; i++) f.repository.records.set(`seed-${i}`, raw(`seed-${i}`));
    assert.deepEqual(await f.create(), { ok: false, error: { kind: 'TagLimitReached', max: 3 } });
    assert.deepEqual(f.repository.calls, ['load-create']);
  });
  test(`tags/${mode}: pure rules need no repository, clock, random id or mutable input`, () => {
    const f = fixture(mode), before = command(), snapshot = structuredClone(before);
    const first = f.decideCreate(before), second = f.decideCreate(before);
    assert.deepEqual(first, second); assert.deepEqual(before, snapshot); assert.equal(f.repository.calls.length, 0);
    assert(first.ok && Object.isFrozen(first.value) && Object.isFrozen(first.value.data));
    if (first.ok) assert(Object.isFrozen(first.value.data.icon));
  });
  test(`tags/${mode}: update combines input and existing entity, preserves id/order, increments version`, async () => {
    const f = fixture(mode); f.repository.records.set('original', raw());
    const result = await f.update({ ...input, id: 'original', label: 'New', icon: null }); assert(result.ok);
    assert.equal(result.value.data.id, 'original'); assert.equal(result.value.data.label, 'New');
    assert.equal(result.value.data.sortOrder, 7); assert.equal(result.value.data.version, 2);
    assert.deepEqual(f.repository.calls, ['load-update', 'save-updated']);
  });
  test(`tags/${mode}: update validation and target mismatch stop saving`, async () => {
    const f = fixture(mode); f.repository.records.set('original', raw());
    const invalid = await f.update({ ...input, id: 'original', label: '' });
    assert(!invalid.ok && invalid.error.kind === 'ValidationError');
    assert.deepEqual(await f.update({ ...input, id: 'original', groupId: 'other' }), { ok: false, error: { kind: 'TargetMismatch' } });
    assert.equal(f.repository.calls.filter(c => c === 'save-updated').length, 0);
    assert.deepEqual(f.repository.records.get('original'), raw());
  });
  test(`tags/${mode}: IO failures and missing entities are typed results`, async () => {
    const f = fixture(mode); assert.deepEqual(await f.create({ ...input, groupId: 'missing' }), { ok: false, error: { kind: 'GroupNotFound' } });
    assert.deepEqual(await f.update({ ...input, id: 'missing' }), { ok: false, error: { kind: 'NotFound' } });
    f.repository.unavailable = true;
    assert.deepEqual(await f.create(), { ok: false, error: { kind: 'RepositoryUnavailable' } });
  });
  test(`tags/${mode}: malformed stored data is rejected during hydration`, async () => {
    const f = fixture(mode); f.repository.records.set('original', { ...raw(), label: 123 });
    assert.deepEqual(await f.update({ ...input, id: 'original' }), { ok: false, error: { kind: 'CorruptStoredTag' } });
    assert.deepEqual(await f.create(), { ok: false, error: { kind: 'CorruptStoredTag' } });
  });
  test(`tags/${mode}: competing creates from one snapshot cannot both commit`, async () => {
    const f = fixture(mode), a = await f.repository.loadCreate(input), b = await f.repository.loadCreate(input);
    assert(a.ok && b.ok); const x = f.decideCreate(a.value), y = f.decideCreate(b.value); assert(x.ok && y.ok);
    const results = await Promise.all([f.repository.saveCreated(x.value), f.repository.saveCreated(y.value)]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert(results.some(r => !r.ok && r.error.kind === 'SaveConflict')); assert.equal(f.repository.records.size, 1);
  });
  test(`tags/${mode}: competing updates reject a stale version without overwriting the winner`, async () => {
    const f = fixture(mode); f.repository.records.set('original', raw());
    const a = await f.repository.loadUpdate({ ...input, id: 'original', label: 'A' });
    const b = await f.repository.loadUpdate({ ...input, id: 'original', label: 'B' }); assert(a.ok && b.ok);
    const x = f.decideUpdate(a.value), y = f.decideUpdate(b.value); assert(x.ok && y.ok);
    assert((await f.repository.saveUpdated(x.value)).ok);
    assert.deepEqual(await f.repository.saveUpdated(y.value), { ok: false, error: { kind: 'SaveConflict' } });
    const stored = restoreTag(f.repository.records.get('original')); assert(stored.ok && stored.value.data.label === 'A');
  });
}

test('both implementations produce identical states, errors and IO calls', async () => {
  const a = fixture('plain'), b = fixture('framework');
  assert.deepEqual(await a.create(), await b.create());
  const change = { ...input, id: 'tag-1', label: 'Changed' };
  assert.deepEqual(await a.update(change), await b.update(change));
  assert.deepEqual(await a.create({ ...input, label: '' }), await b.create({ ...input, label: '' }));
  assert.deepEqual(a.repository.records, b.repository.records); assert.deepEqual(a.repository.calls, b.repository.calls);
});
test('workflow infers and propagates errors while skipping remaining steps', () => {
  const result = createWorkflow.inspect(command({ count: 3 }));
  assert.deepEqual(result.result, { ok: false, error: { kind: 'TagLimitReached', max: 3 } });
  assert.deepEqual(result.trace, [{ step: 'validate-create', status: 'ok' }, { step: 'check-unique-label', status: 'ok' }, { step: 'check-quota', status: 'error' }]);
  const invalid = createWorkflow.inspect({ ...command(), input: { ...input, label: '' } });
  assert.deepEqual(invalid.trace, [{ step: 'validate-create', status: 'error' }]);
});
test('JSX rendering is pure; the actual typed action executes its rendered save node', async () => {
  const f = fixture('framework'), loaded = await f.repository.loadCreate(input); assert(loaded.ok);
  const decision = f.feature.create.prepare(loaded.value); assert(decision.result.ok);
  const current = <f.feature.TagProcess state={decision.result.value} />;
  const described = describeView(current) as { kind: string; operation: string };
  assert.equal(described.kind, 'write'); assert.equal(described.operation, 'tag.create.v1');
  assert.deepEqual(f.repository.calls, ['load-create']);
  assert((await f.feature.create.run(loaded.value)).ok);
  assert.deepEqual(f.repository.calls, ['load-create', 'save-created']);
});
test('same JSX component selects create/update/persisted behavior from the typed state', async () => {
  const f = fixture('framework'), loaded = await f.repository.loadCreate(input); assert(loaded.ok);
  const created = createWorkflow.run(loaded.value); assert(created.ok);
  const saved = await f.repository.saveCreated(created.value); assert(saved.ok);
  const update = await f.repository.loadUpdate({ ...input, id: saved.value.data.id }); assert(update.ok);
  const updated = updateWorkflow.run(update.value); assert(updated.ok);
  const plans = [created.value, updated.value, saved.value].map(state => describeView(f.feature.TagProcess({ state })));
  assert.equal((plans[0] as { operation: string }).operation, 'tag.create.v1');
  assert.equal((plans[1] as { operation: string }).operation, 'tag.update.v1'); assert.deepEqual(plans[2], { kind: 'done' });
});
test('typed application rejects a JSX renderer connected to another binding', async () => {
  const repository = new Repository(), other = createTagFeature(repository);
  const wrong = bindMutation({ workflow: createWorkflow, operation: 'wrong', save: value => repository.saveCreated(value), render: value => other.create.Save({ value }) });
  await assert.rejects(wrong.run(command()), /WrongMutationBinding/); assert.equal(repository.records.size, 0);
});
test('renderer cannot silently replace the pure decision with a modified one', async () => {
  const repository = new Repository();
  const changed = bindMutation({ workflow: createWorkflow, operation: 'changed', save: value => repository.saveCreated(value),
    render: (value): View => changed.Save({ value: { ...value, data: { ...value.data, sortOrder: 999 } } }) });
  await assert.rejects(changed.run(command()), /ChangedDecision/); assert.equal(repository.records.size, 0);
});
test('a completed prepared create can be replayed without creating a second entity', async () => {
  const f = fixture('framework'), loaded = await f.repository.loadCreate(input); assert(loaded.ok);
  const a = await f.feature.create.run(loaded.value), b = await f.feature.create.run(loaded.value);
  assert.deepEqual(a, b); assert.equal(f.repository.records.size, 1);
});
test('save failure can retry the same prepared decision', async () => {
  const f = fixture('framework'), loaded = await f.repository.loadCreate(input); assert(loaded.ok);
  f.repository.failSave = true;
  assert.deepEqual(await f.feature.create.run(loaded.value), { ok: false, error: { kind: 'RepositoryUnavailable' } });
  f.repository.failSave = false; assert((await f.feature.create.run(loaded.value)).ok); assert.equal(f.repository.records.size, 1);
});
test('old update replay cannot overwrite or masquerade as a newer update', async () => {
  const f = fixture('framework'); f.repository.records.set('original', raw());
  const first = await f.repository.loadUpdate({ ...input, id: 'original', label: 'A' }); assert(first.ok);
  assert((await f.feature.update.run(first.value)).ok);
  assert((await f.update({ ...input, id: 'original', label: 'B' })).ok);
  assert.deepEqual(await f.feature.update.run(first.value), { ok: false, error: { kind: 'SaveConflict' } });
});
test('runtime snapshot checks reject invalid or mismatched create context', () => {
  for (const fields of [{ groupId: 'other' }, { version: -1 }, { count: NaN }, { max: 0 }, { nextSortOrder: -1 }]) {
    const result = createWorkflow.run(command(fields)); assert(!result.ok && result.error.kind === 'ValidationError');
  }
});
test('REMAINING LIMIT: repeating a fresh create action is a new command, not an HTTP-idempotent retry', async () => {
  const f = fixture('framework'); await f.create(); await f.create({ ...input, label: 'Second' });
  assert.equal(f.repository.records.size, 2);
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type ErrorOf<T> = T extends { ok: false; error: infer E } ? E : never;
function typeAssertions(repository: Repository, created: CreatedTag, updated: UpdatedTag) {
  const feature = createTagFeature(repository);
  const typedWorkflow: Workflow<CreateCommand, CreatedTag, ValidationError | QuotaError | DuplicateLabel> = createWorkflow;
  const inferredErrors: Equal<ErrorOf<ReturnType<typeof createWorkflow.run>>, ValidationError | QuotaError | DuplicateLabel> = true;
  const actionErrors: Equal<ErrorOf<Awaited<ReturnType<typeof feature.createAction>>>, ValidationError | QuotaError | DuplicateLabel | CreateLoadError | SaveError> = true;
  const exactResult: Promise<Result<PersistedTag, ValidationError | QuotaError | DuplicateLabel | SaveError>> = feature.create.run(command());
  // @ts-expect-error Creation needs AllowedCreate; validation and quota cannot be skipped.
  workflow('wrong', validateCreate).then('create', createTag);
  // @ts-expect-error UpdatedTag construction cannot consume a CreatedTag.
  createWorkflow.then('wrong-update', updateTag);
  // @ts-expect-error IO belongs outside the synchronous pure workflow.
  createWorkflow.then('save', tag => repository.saveCreated(tag));
  // @ts-expect-error An unvalidated command cannot be saved.
  repository.saveCreated(command());
  // @ts-expect-error Private state proof is absent on a fabricated created state.
  const fake: CreatedTag = { kind: 'created', data: created.data, expectedGroupVersion: 0 };
  // @ts-expect-error Creation and update are different save contracts, including in JSX props.
  const wrongJsx = <feature.create.Save value={updated} />;
  // @ts-expect-error Failure inference must not erase the quota branch.
  const erased: Workflow<CreateCommand, CreatedTag, ValidationError> = createWorkflow;
  // @ts-expect-error A mutation cannot pair a created workflow with an update-only adapter.
  bindMutation({ workflow: createWorkflow, operation: 'bad', save: (tag: UpdatedTag) => repository.saveUpdated(tag) });
  return [typedWorkflow, inferredErrors, actionErrors, exactResult, fake, wrongJsx, erased];
}
void typeAssertions;

test('copying a view cannot replace its registered adapter or forge a typed result', async () => {
  const repository = new Repository();
  const forged = bindMutation({ workflow: createWorkflow, operation: 'forged', save: value => repository.saveCreated(value),
    render: (value): View => {
      const copy = { ...forged.Save({ value }), execute: async () => ok('wrong-result') };
      return copy;
    } });
  await assert.rejects(forged.run(command()), /WrongMutationBinding/);
  assert.equal(repository.records.size, 0);
});

test('plain reusable composition is also short and preserves the same decisions', async () => {
  for (const candidate of [command(), command({ count: 3 }), { ...command(), input: { ...input, label: '' } }]) {
    assert.deepEqual(createComposed(candidate), createWorkflow.run(candidate));
  }
  const repository = new Repository(); repository.records.set('original', raw());
  const loaded = await repository.loadUpdate({ ...input, id: 'original' }); assert(loaded.ok);
  assert.deepEqual(updateComposed(loaded.value), updateWorkflow.run(loaded.value));
});

test('old create replay cannot return a later updated entity as its original result', async () => {
  const f = fixture('framework'), loaded = await f.repository.loadCreate(input); assert(loaded.ok);
  const created = await f.feature.create.run(loaded.value); assert(created.ok);
  assert((await f.update({ ...input, id: created.value.data.id, label: 'Later' })).ok);
  assert.deepEqual(await f.feature.create.run(loaded.value), { ok: false, error: { kind: 'SaveConflict' } });
});
