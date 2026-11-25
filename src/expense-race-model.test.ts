import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleModelAsync } from './framework/testing.js';
import { races, raceStep, compareRace, models } from './expenses/race-model-testing.js';

test('independent race alternatives constrain replay, CAS, identity and preloaded authorization failures', async () => {
  for (const scenario of races) {
    const expected = raceStep(0, scenario).output;
    assert.equal(expected.length, 2);
    if (scenario.name === 'same-id-same-approval') for (const candidate of expected) {
      assert.deepEqual(candidate.outcomes.map(output => output.kind).sort(), ['committed', 'replayed']);
      assert.equal(candidate.receipts, 2); assert.equal(candidate.changes, 2);
    }
    if (scenario.name === 'different-ids-same-approval') for (const candidate of expected) {
      assert(candidate.outcomes.some(output => output.kind === 'error' && output.error === 'SaveConflict'));
    }
    if (scenario.name === 'same-id-different-reasons') {
      assert.deepEqual(expected.map(candidate => candidate.expense.reason), ['first', 'second']);
      assert(expected.every(candidate => candidate.outcomes.some(output => output.kind === 'error' && output.error === 'IdempotencyConflict')));
    }
    if (scenario.name === 'self-approval-and-valid-approval') {
      assert(expected.every(candidate => candidate.outcomes[0]?.kind === 'error' && candidate.outcomes[0].error === 'SelfApproval'));
    }
    if (scenario.name === 'both-forbidden') for (const candidate of expected) {
      assert.equal(candidate.expense.version, 2); assert.equal(candidate.receipts, 1); assert.equal(candidate.changes, 1);
    }
    for (const first of [0, 1] as const) {
      assert(await compareRace({ ...scenario, first }, expected), `${scenario.name}, release ${first} first`);
    }
  }
});

test('seeded expense batches compare independent SQLite connections against allowed outcomes', async () => {
  for (const seed of [0, 42, 0xffffffff]) {
    const report = await sampleModelAsync({ ...models['expense-races-sqlite'], seed });
    assert.equal(report.kind, 'sampled', JSON.stringify(report)); assert.equal(report.transitions, 12);
  }
});

test('an oracle that fixes the race winner is refuted by the opposite controlled schedule', async () => {
  const race = { ...races.find(candidate => candidate.name === 'same-id-different-reasons')!, first: 1 as const };
  const report = await sampleModelAsync({ ...models['expense-races-sqlite'], seed: 7,
    limits: { cases: 1, length: 1, shrinkAttempts: 64 },
    events: () => [race],
    step: (round, event) => {
      const expected = raceStep(round, event);
      return { ...expected, output: expected.output.slice(0, 1) }; // Deliberately incorrect fixed-winner oracle.
    },
  });
  assert(report.kind === 'counterexample' && report.reason === 'implementation', JSON.stringify(report));
  assert.equal(report.witness.events.length, 1);
  assert.equal(report.witness.events[0]!.first, 1);
});
