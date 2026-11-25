import { isDeepStrictEqual } from 'node:util';
import { transition, type Result } from '../framework/index.js';
import type { AsyncSequenceModel, ModelStep } from '../framework/testing.js';
import { createTagEvent, updateTagEvent } from './events.js';
import { fixtures, reference, tagEvents, type Event as ChangeEvent, type Expected, type Fixture, type State } from './model-testing.js';
import type { CreatedTag, UpdatedTag, PersistedTag } from './domain.js';

export type ReplayEvent = { type: 'change'; change: ChangeEvent }
  | { type: 'repeat'; receipt: number; changed: boolean };
interface SavedSnapshot { slot: number; label: string; version: number; sortOrder: number }
export interface ReplayState extends State {
  readonly receipts: readonly SavedSnapshot[];
  readonly history: readonly ReplayEvent[];
}
export const initial: ReplayState = { tags: [], receipts: [], history: [] };

// Independent receipt specification. Do not use repository receipts or fingerprints
// to calculate expectations. Tags reject replay once the saved entity has moved on.
export function replayStep(before: ReplayState, event: ReplayEvent): ModelStep<ReplayState, Expected> {
  const history = [...before.history, event];
  if (event.type === 'change') {
    const expected = reference(before, event.change), output = expected.output;
    const receipts = output.kind === 'saved' ? [...before.receipts, {
      slot: event.change.type === 'create' ? before.tags.length : event.change.slot,
      label: output.label, version: output.version, sortOrder: output.sortOrder,
    }] : before.receipts;
    return { state: { tags: expected.state.tags, receipts, history }, output };
  }
  const receipt = before.receipts[event.receipt];
  if (!receipt) throw new Error('ReplayReferenceOutsideModel');
  const current = before.tags[receipt.slot];
  const output: Expected = event.changed || current?.version !== receipt.version || current.label !== receipt.label
    ? { kind: 'rejected', error: { kind: 'SaveConflict' } }
    : { kind: 'saved', label: receipt.label, version: receipt.version, sortOrder: receipt.sortOrder };
  return { state: { ...before, history }, output };
}

export function replayEvents(state: ReplayState, random: () => number): readonly ReplayEvent[] {
  const changes: ReplayEvent[] = tagEvents(state, random).map(change => ({ type: 'change', change }));
  if (!state.receipts.length) return changes;
  const indices = [...new Set([0, state.receipts.length - 1])];
  return [...changes, ...indices.flatMap(receipt => [
    { type: 'repeat' as const, receipt, changed: false },
    { type: 'repeat' as const, receipt, changed: true },
  ])];
}

const create = transition(createTagEvent), rename = transition(updateTagEvent);
export async function compareReplay(createFixture: () => Fixture, before: ReplayState, event: ReplayEvent,
  expected: ModelStep<ReplayState, Expected>, ignoreChangedSnapshot = false): Promise<boolean> {
  const fixture = createFixture(), ids: string[] = [], snapshots: (CreatedTag | UpdatedTag)[] = [];
  const rejected = (error: unknown) => ({ kind: 'rejected', error });
  const output = (result: Result<PersistedTag, unknown>) => result.ok
    ? { kind: 'saved', label: result.value.data.label, version: result.value.data.version, sortOrder: result.value.data.sortOrder }
    : rejected(result.error);
  const stored = (state: ReplayState) => isDeepStrictEqual(
    fixture.rows().map(row => ({ id: row.id, groupId: row.groupId, label: row.label, icon: row.icon, version: row.version, sortOrder: row.sortOrder })).sort((a, b) => a.sortOrder - b.sortOrder),
    state.tags.map((tag, slot) => ({ ...tag, id: ids[slot], groupId: 'g', icon: null, sortOrder: slot })),
  );
  const execute = async (state: ReplayState, operation: ReplayEvent): Promise<unknown> => {
    const repository = fixture.repository;
    if (operation.type === 'repeat') {
      const original = snapshots[operation.receipt];
      if (!original) throw new Error('MissingTestSnapshot');
      // This deliberately bypasses the normal domain decision to probe the save boundary.
      const snapshot = operation.changed && !ignoreChangedSnapshot
        ? { ...original, data: { ...original.data, label: (original.data.label + '!') as typeof original.data.label } } : original;
      const result = snapshot.kind === 'created' ? await repository.saveCreated(snapshot) : await repository.saveUpdated(snapshot);
      if (result.ok && result.value.data.id !== original.data.id) return rejected({ kind: 'WrongIdentity' });
      return output(result);
    }
    const change = operation.change, input = { groupId: 'g', label: change.label, icon: null };
    let decision: CreatedTag | UpdatedTag;
    if (change.type === 'create') {
      const loaded = await repository.loadCreate(input); if (!loaded.ok) return rejected(loaded.error);
      const result = create.run(loaded.value); if (!result.ok) return rejected(result.error);
      decision = result.value;
    } else {
      const loaded = await repository.loadUpdate({ ...input, id: ids[change.slot] ?? 'missing',
        expectedVersion: (state.tags[change.slot]?.version ?? 1) - (change.stale ? 1 : 0) });
      if (!loaded.ok) return rejected(loaded.error);
      const result = rename.run(loaded.value); if (!result.ok) return rejected(result.error);
      decision = result.value;
    }
    const result = decision.kind === 'created' ? await repository.saveCreated(decision) : await repository.saveUpdated(decision);
    if (result.ok) {
      snapshots.push(decision);
      if (change.type === 'create') ids.push(result.value.data.id);
    }
    return output(result);
  };
  try {
    let state = initial;
    // Reconstruct both entity state and receipt history for every comparison,
    // including candidates obtained by deleting earlier generated events.
    for (const previous of before.history) {
      const wanted = replayStep(state, previous), actual = await execute(state, previous);
      if (!isDeepStrictEqual(actual, wanted.output) || !stored(wanted.state)) return false;
      state = wanted.state;
    }
    if (!isDeepStrictEqual(state, before) || !stored(before)) return false;
    return isDeepStrictEqual(await execute(before, event), expected.output) && stored(expected.state);
  } finally { fixture.close(); }
}

export const models: Record<string, Omit<AsyncSequenceModel<ReplayState, ReplayEvent, Expected>, 'seed'>> =
  Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, {
    initial: [initial], limits: { cases: 4, length: 32, shrinkAttempts: 200 },
    events: replayEvents, step: replayStep,
    accepts: (state: ReplayState, event: ReplayEvent) => event.type === 'change' || !!state.receipts[event.receipt],
    invariant: (state: ReplayState) => state.tags.length <= 3 && new Set(state.tags.map(tag => tag.label)).size === state.tags.length,
    check: (before: ReplayState, event: ReplayEvent, expected: ModelStep<ReplayState, Expected>) => compareReplay(fixture, before, event, expected),
  }]));
