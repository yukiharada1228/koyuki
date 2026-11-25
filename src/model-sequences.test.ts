import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleModel, sampleModelAsync, type SequenceModel } from './framework/testing.js';

test('seeded sampling repeats generated choices, supports seed zero, and never claims exhaustive success', () => {
  const run = (seed: number) => {
    const seen: number[] = [];
    const result = sampleModel({ initial: [0], seed, limits: { cases: 3, length: 8, shrinkAttempts: 10 },
      events: (_state: number, random) => [Math.floor(random() * 100), Math.floor(random() * 100)],
      step: (state, event) => ({ state: state + event, output: state + event }),
      check: (_state, event, _expected) => { seen.push(event); return true; } });
    return { result, seen };
  };
  const first = run(0); assert.deepEqual(first, run(0)); assert.notDeepEqual(first.seen, run(1).seen);
  assert.deepEqual(first.result, { kind: 'sampled', seed: 0, cases: 3, transitions: 24, shrinkAttempts: 0 });
});

type State = { armed: boolean; noise: number };
type Event = 'noise' | 'arm' | 'fail';
function broken(shrinkAttempts: number): SequenceModel<State, Event, string> {
  return { initial: [{ armed: false, noise: 0 }], seed: 42, limits: { cases: 2, length: 10, shrinkAttempts },
    events: state => [state.noise < 4 ? 'noise' : state.armed ? 'fail' : 'arm'],
    accepts: (state, event) => event !== 'fail' || state.armed,
    step: (state, event) => {
      assert(event !== 'fail' || state.armed);
      return { state: { armed: state.armed || event === 'arm', noise: state.noise + (event === 'noise' ? 1 : 0) }, output: event };
    },
    check: (state, event) => !(state.armed && event === 'fail'),
  };
}
test('deletion shrinking keeps reference-admissible operations and reproduces the same two-event failure', () => {
  const result = sampleModel(broken(100)); assert.equal(result.kind, 'counterexample');
  assert(result.kind === 'counterexample'); assert.equal(result.reason, 'implementation');
  assert.equal(result.original.events.length, 6); assert.deepEqual(result.witness.events, ['arm', 'fail']);
  assert.equal(result.shrink, 'one-deletion-minimal'); assert(result.shrinkAttempts > 0);
  assert.deepEqual(result, sampleModel(broken(100)));
  for (const remaining of [['arm'], ['fail']] as const) {
    const before: State = result.witness.initial;
    assert(remaining[0] !== 'fail' || !broken(100).accepts!(before, 'fail'));
    if (remaining[0] === 'arm') assert(broken(100).check(before, 'arm', broken(100).step(before, 'arm')));
  }
});

test('zero shrink budget retains the original witness and reports limited, not minimal', () => {
  const result = sampleModel(broken(0)); assert(result.kind === 'counterexample');
  assert.equal(result.shrink, 'limited'); assert.equal(result.shrinkAttempts, 0); assert.deepEqual(result.witness, result.original);
});

test('async comparisons use the identical shrinking engine and preserve rejected defects', async () => {
  const model = broken(100); let active = 0, maximum = 0;
  const result = await sampleModelAsync({ ...model, check: async (before, event, expected) => {
    active++; maximum = Math.max(maximum, active); await Promise.resolve();
    try { return model.check(before, event, expected); } finally { active--; }
  } });
  assert.deepEqual(result, sampleModel(model)); assert.equal(maximum, 1); assert.equal(active, 0);
  const cause = new Error('async check rejected'); let calls = 0;
  const defect = await sampleModelAsync({ ...model, check: async () => { calls++; throw cause; } });
  assert(defect.kind === 'defect'); assert.equal(defect.phase, 'check'); assert.equal(defect.cause, cause); assert.equal(calls, 1);
});

test('concurrent async samplers keep independent seeded choices and owned callback values', async () => {
  const run = async (seed: number, asynchronous: boolean) => {
    const seen: number[] = [];
    const definition = { initial: [{ n: 0 }], seed, limits: { cases: 2, length: 8, shrinkAttempts: 20 },
      events: (_state: { n: number }, random: () => number) => [{ delta: Math.floor(random() * 20) }, { delta: Math.floor(random() * 20) }],
      step: (state: { n: number }, event: { delta: number }) => ({ state: { n: state.n + event.delta }, output: state.n + event.delta }),
      check: (before: { n: number }, event: { delta: number }, expected: { state: { n: number }; output: number }) => {
        seen.push(event.delta); const valid = before.n + event.delta === expected.output;
        before.n = -100; event.delta = -100; expected.state.n = -100; return valid;
      },
    };
    const result = asynchronous ? await sampleModelAsync({ ...definition, check: async (...args) => { await Promise.resolve(); return definition.check(...args); } }) : sampleModel(definition);
    return { result, seen };
  };
  const [left, right] = await Promise.all([run(1, true), run(99, true)]);
  assert.deepEqual(left, await run(1, false)); assert.deepEqual(right, await run(99, false));
  assert.notDeepEqual(left.seen, right.seen);
});

test('model callbacks own independent state, event and expectation copies', () => {
  const initial = { n: 0 }, event = { delta: 1 }, seen: number[] = [];
  const result = sampleModel({ initial: [initial], seed: 1, limits: { cases: 1, length: 4, shrinkAttempts: 5 },
    events: state => { state.n = 500; return [event]; },
    step: (state, action) => { const n = state.n + action.delta; state.n = 700; action.delta = 900; return { state: { n }, output: n }; },
    check: (state, action, expected) => { seen.push(state.n); assert.equal(action.delta, 1); assert.equal(expected.state.n, state.n + 1); state.n = 800; action.delta = 900; expected.state.n = 1000; return true; },
    invariant: state => { state.n = -1; return true; },
  });
  assert.equal(result.kind, 'sampled'); assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.deepEqual(initial, { n: 0 }); assert.deepEqual(event, { delta: 1 });
});

test('defects from generation, checks and shrinking retain their identity and phase', () => {
  const defect = new Error('reference defect');
  const generated = sampleModel({ ...broken(10), events: () => { throw defect; } });
  assert(generated.kind === 'defect'); assert.equal(generated.phase, 'events'); assert.equal(generated.cause, defect);
  const checked = sampleModel({ ...broken(10), check: () => { throw defect; } });
  assert(checked.kind === 'defect'); assert.equal(checked.phase, 'check'); assert.equal(checked.cause, defect);
  const model = broken(100);
  const shrunk = sampleModel({ ...model, check: (state, event, expected) => {
    if (event === 'arm' && state.noise < 3) throw defect;
    return model.check(state, event, expected);
  } });
  assert(shrunk.kind === 'defect'); assert.equal(shrunk.phase, 'check'); assert.equal(shrunk.cause, defect); assert(shrunk.shrinkAttempts > 0);
});

test('invalid ownership and generated inadmissible events stop before implementation checks', () => {
  let calls = 0, getters = 0;
  const initial = Object.defineProperty({}, 'value', { get() { getters++; return 1; }, enumerable: true });
  const owned = sampleModel({ initial: [initial], seed: 0, limits: { cases: 1, length: 1, shrinkAttempts: 0 }, events: () => [], step: () => { calls++; return { state: {}, output: 0 }; }, check: () => { calls++; return true; } });
  assert(owned.kind === 'defect'); assert.equal(owned.phase, 'snapshot'); assert.equal(getters, 0); assert.equal(calls, 0);
  const invalid = sampleModel({ ...broken(10), events: () => ['fail' as const], check: () => { calls++; return true; } });
  assert(invalid.kind === 'defect'); assert.equal(invalid.phase, 'accepts'); assert.equal(calls, 0);
});

test('initial invariants, empty event sets and explicit limits are distinct outcomes', () => {
  const invalid = sampleModel({ ...broken(10), invariant: () => false });
  assert(invalid.kind === 'counterexample'); assert.equal(invalid.reason, 'invariant'); assert.deepEqual(invalid.witness.events, []); assert.equal(invalid.shrink, 'one-deletion-minimal');
  const empty = sampleModel({ ...broken(10), events: () => [] });
  assert.deepEqual(empty, { kind: 'sampled', seed: 42, cases: 2, transitions: 0, shrinkAttempts: 0 });
  for (const seed of [-1, 0x100000000, 1.5, NaN]) assert.throws(() => sampleModel({ ...broken(0), seed }), /InvalidSequenceSamplingLimits/);
  for (const limits of [{ cases: 0, length: 1, shrinkAttempts: 0 }, { cases: 1, length: -1, shrinkAttempts: 0 }, { cases: 1, length: 1, shrinkAttempts: -1 }]) assert.throws(() => sampleModel({ ...broken(0), limits }), /InvalidSequenceSamplingLimits/);
  if (false) {
    // @ts-expect-error model implementation comparisons must be synchronous booleans
    sampleModel({ ...broken(10), check: async () => true });
  }
});
