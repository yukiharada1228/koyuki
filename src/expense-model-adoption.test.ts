import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreModel, type ModelStep } from './framework/testing.js';
import { actual, events, initial, matchesImplementation, modelKey, modelStep, noSelfApproval, type Spec, type Event, type Expected } from './expenses/model-testing.js';

test('a type-correct expense defect is exposed by the full model but hidden by an unsound state key', () => {
  // This adapter defect changes a business answer without changing any types.
  // It is an isolated mutation probe, not a new expense policy.
  const faulty: typeof actual = (state, event) => actual(state,
    state.amount === 3001 && event.type === 'submit'
      ? { ...event, actor: { ...event.actor, active: false } } : event);
  const definition = {
    initial,
    events: () => events.filter(event => event.type !== 'edit'),
    step: modelStep,
    invariant: noSelfApproval,
    check: (before: Spec, event: Event, expected: ModelStep<Spec, Expected>) =>
      matchesImplementation(before, event, expected, faulty),
    limits: { depth: 4, states: 1000, transitions: 100000 },
  };
  const faithful = exploreModel({ ...definition, key: modelKey });
  assert(faithful.kind === 'counterexample' && faithful.reason === 'implementation', JSON.stringify(faithful));
  assert.equal(faithful.witness.initial.amount, 3001);
  assert.equal(faithful.witness.events.length, 1);
  assert.equal(faithful.witness.events[0]!.type, 'submit');

  // kind alone merges the 3000 and 3001 initial drafts. Their future behavior
  // differs, so this key violates the documented equivalence contract.
  const misleading = exploreModel({ ...definition, key: state => state.kind });
  assert.equal(misleading.kind, 'passed', JSON.stringify(misleading));
  assert.equal(misleading.states, 2);
  assert.equal(misleading.transitions, 96);
  // A passed finite report is meaningful only under the supplied abstraction.
  // The engine cannot discover an omitted business distinction automatically.
});
