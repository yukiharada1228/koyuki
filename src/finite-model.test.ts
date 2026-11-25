import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreModel, type FiniteModel } from './framework/testing.js';

function counter(overrides: Partial<FiniteModel<number, number, number>> = {}): FiniteModel<number, number, number> {
  return { initial: [0], key: String, events: n => n < 3 ? [1] : [], step: (n, e) => ({ state: n + e, output: n + e }),
    check: (_n, _e, expected) => expected.state === expected.output, limits: { depth: 3, states: 4, transitions: 3 }, ...overrides };
}
test('finite model exhausts an explicit graph and a cycle without executing duplicate states', () => {
  assert.deepEqual(exploreModel(counter()), { kind: 'passed', states: 4, transitions: 3, maxDepth: 3 });
  assert.deepEqual(exploreModel(counter({ events: () => [0] })), { kind: 'passed', states: 1, transitions: 1, maxDepth: 1 });
});
test('depth, state and transition truncation never report passed', () => {
  for (const [limits, reason] of [
    [{ depth: 0, states: 4, transitions: 3 }, 'depth'],
    [{ depth: 3, states: 1, transitions: 3 }, 'states'],
    [{ depth: 3, states: 4, transitions: 1 }, 'transitions'],
  ] as const) {
    const result = exploreModel(counter({ limits })); assert(result.kind === 'limited'); assert(result.limits.includes(reason));
  }
});
test('a breadth-first counterexample includes a replayable shortest event sequence', () => {
  const result = exploreModel(counter({ events: n => n < 3 ? [1, 2] : [], check: (_n, _e, expected) => expected.state !== 2 }));
  assert.equal(result.kind, 'counterexample');
  if (result.kind === 'counterexample') assert.deepEqual(result.witness, { initial: 0, events: [2] });
});
test('initial invariants are checked before deeper implementation failures', () => {
  const result = exploreModel(counter({ initial: [0, -1], invariant: n => n >= 0, check: () => false }));
  assert(result.kind === 'counterexample' && result.reason === 'invariant');
  assert.deepEqual(result.witness, { initial: -1, events: [] });
});
test('invariants apply even to duplicate keys and states beyond the enqueue budget', () => {
  for (const settings of [{ key: () => 'same' }, { limits: { depth: 3, states: 1, transitions: 3 } }]) {
    const result = exploreModel(counter({ ...settings, invariant: n => n === 0 }));
    assert(result.kind === 'counterexample' && result.reason === 'invariant');
    assert.deepEqual(result.witness.events, [1]);
  }
});
test('callback and snapshot exceptions are defects, never proof of a valid model', () => {
  const cause = Error('broken');
  for (const phase of ['key', 'events', 'step', 'check', 'invariant'] as const) {
    const result = exploreModel(counter({ [phase]: () => { throw cause; } }));
    assert(result.kind === 'defect' && result.phase === phase); assert.equal(result.cause, cause);
  }
  const snapshot = exploreModel({ ...counter(), initial: [() => 1] } as unknown as FiniteModel<number, number, number>);
  assert(snapshot.kind === 'defect' && snapshot.phase === 'snapshot'); assert.equal(snapshot.witness, undefined);
});
test('mutation in callbacks cannot contaminate another edge or the caller state', () => {
  const initial = { count: 0 }, event = { delta: 1 };
  const result = exploreModel({ initial: [initial], key: s => String(s.count), events: s => { s.count = 99; return [event, event]; },
    step: (s, e) => { s.count += e.delta; e.delta = 99; return { state: s, output: s.count }; },
    check: (before, e, expected) => { const matches = before.count === 0 && e.delta === 1 && expected.state.count === 1; expected.state.count = 999; return matches; },
    limits: { depth: 1, states: 2, transitions: 2 } });
  assert(result.kind === 'limited' && result.transitions === 2); assert.deepEqual(initial, { count: 0 }); assert.deepEqual(event, { delta: 1 });
});
test('invalid budgets are rejected before model callbacks execute', () => {
  let calls = 0;
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => exploreModel(counter({ key: () => { calls++; return ''; }, limits: { depth: value, states: 1, transitions: 1 } })), /InvalidModelLimits/);
  }
  assert.throws(() => exploreModel(counter({ limits: { depth: 1, states: 0, transitions: 1 } })), /InvalidModelLimits/);
  assert.throws(() => exploreModel(counter({ limits: { depth: 1, states: 1, transitions: 0 } })), /InvalidModelLimits/);
  assert.equal(calls, 0);
});
test('a deliberately incorrect implementation is detected rather than sharing its answer with the model', () => {
  const implementation = (n: number, e: number) => n + e + 1;
  const result = exploreModel(counter({ check: (n, e, expected) => implementation(n, e) === expected.output }));
  assert(result.kind === 'counterexample' && result.reason === 'implementation'); assert.deepEqual(result.witness.events, [1]);
});
test('an empty event frontier is exhausted even at depth zero; no initial states is a defect', () => {
  assert.deepEqual(exploreModel(counter({ events: () => [], limits: { depth: 0, states: 1, transitions: 1 } })), { kind: 'passed', states: 1, transitions: 0, maxDepth: 0 });
  const empty = exploreModel(counter({ initial: [] })); assert(empty.kind === 'defect' && empty.phase === 'snapshot');
});
test('unexplored initial states and uncloneable outputs cannot be silently accepted', () => {
  const initial = exploreModel(counter({ initial: [0, 9], events: () => [], limits: { depth: 0, states: 1, transitions: 1 } }));
  assert(initial.kind === 'limited' && initial.limits.includes('states'));
  let checked = false;
  const uncloneable = exploreModel({ ...counter(), step: () => ({ state: 1, output: () => 1 }), check: () => { checked = true; return true; } });
  assert(uncloneable.kind === 'defect' && uncloneable.phase === 'snapshot'); assert.equal(checked, false);
});
if (false) {
  // @ts-expect-error checks must be synchronous so a Promise cannot count as truthy proof
  exploreModel(counter({ check: async () => true }));
  // @ts-expect-error model transitions must preserve the declared state type
  exploreModel(counter({ step: () => ({ state: 'wrong', output: 1 }) }));
  // @ts-expect-error every explored edge has an explicit comparison output
  exploreModel(counter({ step: n => ({ state: n }) }));
}
