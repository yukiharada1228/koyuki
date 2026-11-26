import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, ok } from './framework/index.js';
import { validateCreate, checkUniqueCreate, checkQuota, createTag, restoreTag,
  type CreateCommand, type ValidatedCreate, type CreatedTag, type PersistedTag } from './tags/domain.js';

const command: CreateCommand = {
  kind: 'create-unvalidated', input: { groupId: 'g1', label: ' VIP ', icon: null },
  snapshot: { newId: 'candidate-id', groupId: 'g1', version: 3, count: 0, max: 10, nextSortOrder: 7, existingLabels: [] },
};
const flow = workflow('validate', validateCreate).then('unique', checkUniqueCreate).then('quota', checkQuota).then('create', createTag);
test('tag creation is modeled before persistence and each required state has its own fields', () => {
  const before = structuredClone(command);
  assert(!Object.hasOwn(command, 'data'));
  const checked = validateCreate(command); assert(checked.ok);
  assert.equal(checked.value.kind, 'create-validated'); assert.equal(checked.value.fields.label, 'VIP');
  assert(!Object.hasOwn(checked.value, 'data'));
  const result = flow.inspect(command);
  assert.deepEqual(result, { result: ok({ kind: 'created', expectedGroupVersion: 3,
    data: { id: 'candidate-id', groupId: 'g1', label: 'VIP', icon: null, sortOrder: 7, version: 1 },
  }), trace: [{ step: 'validate', status: 'ok' }, { step: 'unique', status: 'ok' }, { step: 'quota', status: 'ok' }, { step: 'create', status: 'ok' }] });
  assert.deepEqual(command, before);
  // No repository is involved. The host supplied the candidate ID in the snapshot.
});

test('restoring a tag validates its stored-data shape without proving a database write occurred', () => {
  const created = flow.run(command); assert(created.ok);
  const restored = restoreTag(created.value.data); assert(restored.ok);
  assert.equal(restored.value.kind, 'persisted'); assert.deepEqual(restored.value.data, created.value.data);
  assert(Object.isFrozen(restored.value)); assert(Object.isFrozen(restored.value.data));
  assert.deepEqual(restoreTag({ ...created.value.data, id: undefined }), { ok: false, error: { kind: 'CorruptStoredTag' } });
  assert.deepEqual(restoreTag({ ...created.value.data, version: 0 }), { ok: false, error: { kind: 'CorruptStoredTag' } });
});

function stateContracts(raw: CreateCommand, validated: ValidatedCreate, created: CreatedTag) {
  // @ts-expect-error no full created data exists on the unvalidated command
  raw.data;
  // @ts-expect-error validation has not yet produced created data
  validated.data;
  // @ts-expect-error validation alone does not provide uniqueness and quota proofs
  createTag(validated);
  // @ts-expect-error a created plan is not the restored/persisted-shaped variant
  const stored: PersistedTag = created;
  // @ts-expect-error created data requires an ID, without an optional placeholder
  const missingId: CreatedTag = { ...created, data: { ...created.data, id: undefined } };
  void [stored, missingId];
}
void stateContracts;
