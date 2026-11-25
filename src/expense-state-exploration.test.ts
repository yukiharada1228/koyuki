import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { exploreModel, sampleModel, type ModelStep } from './framework/testing.js';
import { initial, modelKey, events, modelStep, noSelfApproval, matchesImplementation,
  actors, amounts, actual, sequenceEvents, type Spec, type Event, type Expected } from './expenses/model-testing.js';

test('bounded breadth-first expense exploration agrees with an independent specification', t => {
  const depthLimit = 7;
  const reached = new Set<string>();
  let failures = 0, repeatedCorrection = false, resubmission = false;
  const result = exploreModel({
    initial,
    key: modelKey,
    events: () => events,
    step: modelStep,
    check: (before, event, expected) => {
      reached.add(before.kind); reached.add(expected.state.kind);
      repeatedCorrection ||= (expected.state.draftVersion ?? 0) >= 7;
      resubmission ||= expected.state.kind === 'manager' && expected.state.draftVersion === 4;
      if ('error' in expected.output) failures++;
      return matchesImplementation(before, event, expected);
    },
    limits: { depth: depthLimit, states: 1000, transitions: 100000 },
  });
  // Repeated correction cycles make the versioned model unbounded. Reaching the
  // selected horizon is a LIMITED result, never a universal proof of safety.
  assert(result.kind === 'limited' && isDeepStrictEqual(result.limits, ['depth']), JSON.stringify(result));
  assert.deepEqual([...reached].sort(), ['approved', 'draft', 'finance', 'manager', 'rejected', 'returned']);
  assert(result.states >= 100 && result.transitions > 10000 && failures > 10000);
  assert(repeatedCorrection && resubmission);
  t.diagnostic(JSON.stringify({ ...result, rejectedEdges: failures, eventsPerState: events.length }));
});

test('the finite approval episode exhausts its graph without self approval or terminal reapproval', t => {
  // This scenario deliberately excludes edit/resubmission, which would make
  // version growth unbounded. Return is terminal only WITHIN this event set.
  const episodeEvents = events.filter(event => event.type !== 'edit');
  let terminalChecks = 0, selfChecks = 0;
  const result = exploreModel({
    initial, key: modelKey, events: () => episodeEvents, step: modelStep,
    invariant: noSelfApproval,
    check: (before, event, expected) => {
      if (event.type === 'approve' && ['approved', 'rejected', 'returned'].includes(before.kind)) {
        terminalChecks++;
        if (!('error' in expected.output) || expected.output.error !== 'InvalidState' || !isDeepStrictEqual(before, expected.state)) return false;
      }
      if (event.type === 'approve' && (before.kind === 'manager' || before.kind === 'finance') && event.actor.id === before.owner) {
        selfChecks++;
        if (!('error' in expected.output) || expected.output.error !== 'SelfApproval' || !isDeepStrictEqual(before, expected.state)) return false;
      }
      return matchesImplementation(before, event, expected);
    },
    limits: { depth: 4, states: 1000, transitions: 100000 },
  });
  assert.equal(result.kind, 'passed', JSON.stringify(result));
  assert(terminalChecks > 0 && selfChecks > 0);
  t.diagnostic(JSON.stringify({ ...result, terminalChecks, selfChecks, eventsPerState: episodeEvents.length }));
});

test('the no-self-approval invariant exposes a deliberately broken reference transition', () => {
  const result = exploreModel({
    initial: initial.filter(state => state.amount === 100001 && state.receipt),
    key: modelKey, events: () => events.filter(event => event.type === 'submit' || event.type === 'approve'),
    step: (state, event): ModelStep<Spec, Expected> => {
      if (state.kind === 'manager' && event.type === 'approve' && event.actor.id === state.owner) {
        const next: Spec = { ...state, kind: 'approved', version: state.version + 1, approval: { kind: 'manager', manager: state.owner } };
        return { state: next, output: { next } };
      }
      return modelStep(state, event);
    },
    invariant: noSelfApproval,
    // Model-only mutation probe: the independent invariant must catch the
    // corrupt model even with no implementation comparison to rescue it.
    check: () => true,
    limits: { depth: 4, states: 1000, transitions: 100000 },
  });
  assert(result.kind === 'counterexample' && result.reason === 'invariant', JSON.stringify(result));
  assert.deepEqual(result.witness.events.map(event => event.type), ['submit', 'approve']);
  assert.equal(result.witness.events[1]!.actor.id, result.witness.initial.owner);
});

test('seeded expense sequences cover amount boundaries, authorization, corrections and terminal states against the independent specification', t => {
  const reached = new Set<string>(), failures = new Set<string>(), boundaryAmounts = new Set<number>();
  for (const seed of [0, 1, 0xffffffff]) {
    const result = sampleModel({ initial, seed, limits: { cases: 64, length: 32, shrinkAttempts: 200 },
      events: sequenceEvents,
      step: modelStep, invariant: noSelfApproval,
      check: (before, event, expected) => {
        reached.add(before.kind); reached.add(expected.state.kind); boundaryAmounts.add(before.amount);
        if ('error' in expected.output) failures.add(expected.output.error);
        return matchesImplementation(before, event, expected);
      },
    });
    assert.equal(result.kind, 'sampled', JSON.stringify(result));
    t.diagnostic(JSON.stringify(result));
  }
  assert.deepEqual([...reached].sort(), ['approved', 'draft', 'finance', 'manager', 'rejected', 'returned']);
  assert.deepEqual([...boundaryAmounts].sort((a, b) => a - b), [...amounts]);
  for (const failure of ['Forbidden', 'SelfApproval', 'ReceiptRequired', 'ReasonRequired', 'InvalidState', 'InvalidExpense']) assert(failures.has(failure), failure);
});

test('seeded expense checks shrink a deliberately faulty actor adaptation to submit then self-approve', () => {
  const buggy: typeof actual = (state, event) => actual(state, event.type === 'approve' && event.actor.id === state.owner
    ? { ...event, actor: { id: 'wrong-trusted-actor', role: 'manager', active: true } } : event);
  const result = sampleModel({ initial: initial.filter(state => state.amount === 100001 && state.receipt), seed: 7,
    limits: { cases: 1, length: 8, shrinkAttempts: 100 },
    events: state => events.filter(event => state.kind === 'draft' ? event.type === 'submit' && event.actor === actors[0]
      : event.type === 'approve' && event.actor === actors[7]),
    step: modelStep, invariant: noSelfApproval,
    shrinkInitial: state => state.amount > 3001 ? [
      { ...state, amount: 3000 }, { ...state, amount: 3001, receipt: false }, { ...state, amount: 3001 },
    ] : [],
    check: (before, event, expected) => matchesImplementation(before, event, expected, buggy),
  });
  assert(result.kind === 'counterexample' && result.reason === 'implementation', JSON.stringify(result));
  assert.equal(result.shrink, 'one-deletion-minimal');
  assert.deepEqual(result.witness.events.map(event => event.type), ['submit', 'approve']);
  assert.equal(result.witness.events[1]!.actor.id, result.witness.initial.owner);
  assert.equal(result.original.initial.amount, 100001);
  assert.equal(result.witness.initial.amount, 3001);
  assert.equal(result.witness.initial.receipt, true);
});
