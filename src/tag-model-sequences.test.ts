import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleModel, type ModelStep } from './framework/testing.js';
import { Repository, type TagRepository } from './tags/repository.js';
import { SqliteTagRepository } from './tags/sqlite.js';
import { tagModel } from './tags/model.js';
import { createTagEvent, updateTagEvent } from './tags/events.js';
import type { RawTag } from './tags/domain.js';

interface Tag { readonly label: string; readonly version: number }
interface State { readonly tags: readonly Tag[] }
interface Event { readonly type: 'create' | 'rename'; readonly slot: number; readonly label: string; readonly stale: boolean }
type Rejection = { kind: 'ValidationError'; fields: readonly string[] } | { kind: 'DuplicateLabel'; label: string }
  | { kind: 'TagLimitReached'; max: number } | { kind: 'NotFound' } | { kind: 'SaveConflict' };
type Expected = { kind: 'saved'; label: string; version: number; sortOrder: number } | { kind: 'rejected'; error: Rejection };
// Independent specification. Do not call domain constructors, validators,
// repository methods or framework transitions to calculate expectations.
function reference(state: State, event: Event): ModelStep<State, Expected> {
  const reject = (error: Rejection): ModelStep<State, Expected> => ({ state, output: { kind: 'rejected', error } });
  const current = state.tags[event.slot];
  if (event.type === 'rename') {
    if (!current) return reject({ kind: 'NotFound' });
    if (event.stale) return reject({ kind: 'SaveConflict' });
  }
  if (!event.label.trim() || event.label.trim().length > 30) return reject({ kind: 'ValidationError', fields: ['label'] });
  const label = event.label.trim().normalize('NFC');
  if (state.tags.some((tag, slot) => tag.label === label && (event.type === 'create' || slot !== event.slot))) return reject({ kind: 'DuplicateLabel', label });
  if (event.type === 'create') {
    if (state.tags.length >= 3) return reject({ kind: 'TagLimitReached', max: 3 });
    return { state: { tags: [...state.tags, { label, version: 1 }] }, output: { kind: 'saved', label, version: 1, sortOrder: state.tags.length } };
  }
  const version = current!.version + 1;
  return { state: { tags: state.tags.map((tag, slot) => slot === event.slot ? { label, version } : tag) }, output: { kind: 'saved', label, version, sortOrder: event.slot } };
}
const labels = ['', ' ', 'A', ' A ', 'B', 'C', 'D', 'E', 'e\u0301', 'é', 'x'.repeat(30), 'x'.repeat(31)];
interface Row { readonly before: State; readonly event: Event; readonly expected: ModelStep<State, Expected> }
function generate(seed: number): readonly Row[] {
  const rows: Row[] = [];
  const result = sampleModel<State, Event, Expected>({ initial: [{ tags: [] }], seed, limits: { cases: 1, length: 64, shrinkAttempts: 0 },
    events: (state, random) => {
      const label = labels[Math.floor(random() * labels.length)]!;
      const slot = state.tags.length ? Math.floor(random() * state.tags.length) : 0;
      return [
        { type: 'create', slot: 0, label, stale: false },
        { type: 'create', slot: 0, label: state.tags[0]?.label ?? 'A', stale: false },
        { type: 'create', slot: 0, label: labels[2 + Math.floor(random() * 6)]!, stale: false },
        { type: 'rename', slot, label, stale: false },
        { type: 'rename', slot, label, stale: true },
        { type: 'rename', slot, label: state.tags[(slot + 1) % Math.max(1, state.tags.length)]?.label ?? 'B', stale: false },
        { type: 'rename', slot: 3, label, stale: false },
      ];
    },
    step: reference,
    invariant: state => state.tags.length <= 3 && new Set(state.tags.map(tag => tag.label)).size === state.tags.length,
    // Capture reference edges only. The async adapter comparisons below must
    // all finish before this test can pass; sampled alone proves no parity.
    check: (before, event, expected) => { rows.push({ before, event, expected }); return true; },
  });
  assert.equal(result.kind, 'sampled'); assert.equal(rows.length, 64);
  return rows;
}
interface Fixture { repository: TagRepository; rows(): readonly RawTag[]; close(): void }
const fixtures: Record<string, () => Fixture> = {
  memory: () => { const repository = new Repository(); return { repository, rows: () => [...repository.records.values()] as RawTag[], close() {} }; },
  sqlite: () => {
    const repository = new SqliteTagRepository(':memory:');
    return { repository, rows: () => { const result = repository.list('g'); assert(result.ok); return result.value; }, close: () => repository.close() };
  },
};
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
