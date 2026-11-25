import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleModel, sampleModelAsync, type ModelStep } from './framework/testing.js';
import { tagModel } from './tags/model.js';
import { createTagEvent, updateTagEvent } from './tags/events.js';
import { reference, tagEvents, fixtures, compareTag, type State, type Event, type Expected } from './tags/model-testing.js';

interface Row { readonly before: State; readonly event: Event; readonly expected: ModelStep<State, Expected> }
function generate(seed: number): readonly Row[] {
  const rows: Row[] = [];
  const result = sampleModel<State, Event, Expected>({ initial: [{ tags: [] }], seed, limits: { cases: 1, length: 64, shrinkAttempts: 0 },
    events: tagEvents,
    step: reference,
    invariant: state => state.tags.length <= 3 && new Set(state.tags.map(tag => tag.label)).size === state.tags.length,
    // Capture reference edges only. The async adapter comparisons below must
    // all finish before this test can pass; sampled alone proves no parity.
    check: (before, event, expected) => { rows.push({ before, event, expected }); return true; },
  });
  assert.equal(result.kind, 'sampled'); assert.equal(rows.length, 64);
  return rows;
}
for (const [name, createFixture] of Object.entries(fixtures)) test(`seeded tag contract uses the same independent cases for ${name}`, async t => {
  const rejected = new Set<string>(), observedLabels = new Set<string>(); let checked = 0, renamed = false;
  for (const seed of [0, 1, 42, 99, 0xffffffff]) {
    const rows = generate(seed); assert.deepEqual(rows, generate(seed));
    const fixture = createFixture(), model = tagModel(fixture.repository);
    const create = model.creation.on(createTagEvent), rename = model.revision.on(updateTagEvent), ids: string[] = [];
    const stored = (state: State) => {
      const actual = fixture.rows().map(row => ({ id: row.id, groupId: row.groupId, label: row.label, icon: row.icon, version: row.version, sortOrder: row.sortOrder })).sort((a, b) => a.sortOrder - b.sortOrder);
      assert.deepEqual(actual, state.tags.map((tag, slot) => ({ ...tag, id: ids[slot], groupId: 'g', icon: null, sortOrder: slot })), `seed ${seed}, edge ${checked}`);
    };
    try {
      for (const { before, event, expected } of rows) {
        observedLabels.add(event.label);
        stored(before);
        const input = { groupId: 'g', label: event.label, icon: null };
        const result = event.type === 'create' ? await create.run(input) : await rename.run({ ...input, id: ids[event.slot] ?? `missing-${event.slot}`,
          expectedVersion: (before.tags[event.slot]?.version ?? 1) - (event.stale ? 1 : 0) });
        if (expected.output.kind === 'rejected') {
          assert.deepEqual(result, { ok: false, error: expected.output.error }, `seed ${seed}, edge ${checked}`);
          rejected.add(expected.output.error.kind);
        } else {
          assert(result.ok, `seed ${seed}, edge ${checked}: ${JSON.stringify(result)}`);
          const { label, version, sortOrder } = result.value.data;
          assert.deepEqual({ kind: 'saved', label, version, sortOrder }, expected.output);
          if (event.type === 'create') {
            assert(result.value.data.id.length > 0 && !ids.includes(result.value.data.id)); ids.push(result.value.data.id);
          } else { assert.equal(result.value.data.id, ids[event.slot]); renamed = true; }
        }
        stored(expected.state); checked++;
      }
    } finally { fixture.close(); }
  }
  assert.equal(checked, 320);
  assert(renamed);
  for (const label of ['', ' A ', 'e\u0301', 'x'.repeat(30), 'x'.repeat(31)]) assert(observedLabels.has(label), JSON.stringify(label));
  assert.deepEqual([...rejected].sort(), ['DuplicateLabel', 'NotFound', 'SaveConflict', 'TagLimitReached', 'ValidationError']);
  t.diagnostic(JSON.stringify({ adapter: name, seeds: 5, checked }));
});

for (const [name, createFixture] of Object.entries(fixtures)) test(`async shrinking isolates ${name} checks and finds an adapter that ignores stale versions`, async () => {
  let opened = 0, closed = 0;
  const compare = async (before: State, event: Event, expected: ModelStep<State, Expected>, faulty: boolean): Promise<boolean> => {
    return compareTag(() => {
      const fixture = createFixture(); opened++;
      return { ...fixture, close() { fixture.close(); closed++; } };
    }, before, event, expected, faulty);
  };
  const model = { initial: [{ tags: [] }] as State[], seed: 7, limits: { cases: 2, length: 5, shrinkAttempts: 100 },
    events: (state: State): Event[] => [state.tags.length === 0 ? { type: 'create', slot: 0, label: 'A', stale: false } : { type: 'rename', slot: 0, label: 'B', stale: true }], step: reference };
  const healthy = await sampleModelAsync({ ...model, check: (before, event, expected) => compare(before, event, expected, false) });
  assert.equal(healthy.kind, 'sampled'); assert.equal(opened, closed);
  const broken = await sampleModelAsync({ ...model, check: (before, event, expected) => compare(before, event, expected, true) });
  assert(broken.kind === 'counterexample' && broken.reason === 'implementation', JSON.stringify(broken));
  assert.equal(broken.shrink, 'one-deletion-minimal');
  assert.deepEqual(broken.witness.events.map(event => event.type), ['create', 'rename']); assert(broken.witness.events[1]!.stale);
  const simplified = await sampleModelAsync({ ...model,
    shrinkEvent: (event: Event) => event.type === 'rename' && event.label ? [{ ...event, label: '' }] : [],
    check: (before, event, expected) => compare(before, event, expected, true) });
  assert(simplified.kind === 'counterexample' && simplified.reason === 'implementation', JSON.stringify(simplified));
  assert.equal(simplified.shrink, 'one-deletion-minimal');
  assert.deepEqual(simplified.witness.events.map(event => event.type), ['create', 'rename']);
  assert.equal(simplified.original.events[1]!.label, 'B'); assert.equal(simplified.witness.events[1]!.label, '');
  assert.equal(opened, closed); assert(opened > 10);
});
