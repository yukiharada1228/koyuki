import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { ModelStep, AsyncSequenceModel } from '../framework/testing.js';
import { Repository, type TagRepository } from './repository.js';
import { SqliteTagRepository } from './sqlite.js';
import { tagModel } from './model.js';
import { createTagEvent, updateTagEvent } from './events.js';
import type { RawTag } from './domain.js';

interface Tag { readonly label: string; readonly version: number }
export interface State { readonly tags: readonly Tag[] }
export interface Event { readonly type: 'create' | 'rename'; readonly slot: number; readonly label: string; readonly stale: boolean }
type Rejection = { kind: 'ValidationError'; fields: readonly string[] } | { kind: 'DuplicateLabel'; label: string }
  | { kind: 'TagLimitReached'; max: number } | { kind: 'NotFound' } | { kind: 'SaveConflict' };
export type Expected = { kind: 'saved'; label: string; version: number; sortOrder: number } | { kind: 'rejected'; error: Rejection };
// Independent specification. Do not call domain constructors, validators,
// repository methods or framework transitions to calculate expectations.
export function reference(state: State, event: Event): ModelStep<State, Expected> {
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
export const labels = ['', ' ', 'A', ' A ', 'B', 'C', 'D', 'E', 'e\u0301', 'é', 'x'.repeat(30), 'x'.repeat(31)];
export interface Fixture { repository: TagRepository; rows(): readonly RawTag[]; close(): void }
export const fixtures: Record<string, () => Fixture> = {
  memory: () => { const repository = new Repository(); return { repository, rows: () => [...repository.records.values()] as RawTag[], close() {} }; },
  sqlite: () => {
    const repository = new SqliteTagRepository(':memory:');
    return { repository, rows: () => { const result = repository.list('g'); assert(result.ok); return result.value; }, close: () => repository.close() };
  },
};
export async function compareTag(createFixture: () => Fixture, before: State, event: Event, expected: ModelStep<State, Expected>, faulty = false): Promise<boolean> {
  const fixture = createFixture();
  try {
    const correct = tagModel(fixture.repository), create = correct.creation.on(createTagEvent), rename = correct.revision.on(updateTagEvent);
    const ids: string[] = [];
    // Reconstruct THIS supplied before-state, including versions, in a fresh
    // test fixture. Never reuse the database from a discarded shrink candidate.
    for (const tag of before.tags) {
      const created = await create.run({ groupId: 'g', label: tag.label, icon: null }); assert(created.ok);
      const id = created.value.data.id; ids.push(id);
      for (let version = 1; version < tag.version; version++) {
        const updated = await rename.run({ groupId: 'g', id, label: tag.label, icon: null, expectedVersion: version }); assert(updated.ok);
      }
    }
    const repository: TagRepository = faulty ? {
      loadCreate: fixture.repository.loadCreate.bind(fixture.repository),
      loadUpdate: input => fixture.repository.loadUpdate({ ...input, expectedVersion: undefined }),
      saveCreated: fixture.repository.saveCreated.bind(fixture.repository),
      saveUpdated: fixture.repository.saveUpdated.bind(fixture.repository),
    } : fixture.repository;
    const target = tagModel(repository), input = { groupId: 'g', label: event.label, icon: null };
    const result = event.type === 'create' ? await target.creation.on(createTagEvent).run(input)
      : await target.revision.on(updateTagEvent).run({ ...input, id: ids[event.slot] ?? 'missing', expectedVersion: (before.tags[event.slot]?.version ?? 1) - (event.stale ? 1 : 0) });
    const output = result.ok
      ? { kind: 'saved' as const, label: result.value.data.label, version: result.value.data.version, sortOrder: result.value.data.sortOrder }
      : { kind: 'rejected' as const, error: result.error };
    if (result.ok && event.type === 'create') ids.push(result.value.data.id);
    const actual = fixture.rows().map(row => ({ id: row.id, label: row.label, version: row.version, sortOrder: row.sortOrder })).sort((a, b) => a.sortOrder - b.sortOrder);
    const wanted = expected.state.tags.map((tag, slot) => ({ ...tag, id: ids[slot], sortOrder: slot }));
    return isDeepStrictEqual(output, expected.output) && isDeepStrictEqual(actual, wanted);
  } finally { fixture.close(); }
}

export function tagEvents(state: State, random: () => number): readonly Event[] {
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
}

// The same independent specification is used for both host adapters.
export const models: Record<string, Omit<AsyncSequenceModel<State, Event, Expected>, 'seed'>> =
  Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, {
    initial: [{ tags: [] }],
    limits: { cases: 1, length: 64, shrinkAttempts: 100 },
    events: tagEvents,
    step: reference,
    invariant: (state: State) => state.tags.length <= 3 && new Set(state.tags.map(tag => tag.label)).size === state.tags.length,
    check: (before: State, event: Event, expected: ModelStep<State, Expected>) => compareTag(fixture, before, event, expected),
  }]));
