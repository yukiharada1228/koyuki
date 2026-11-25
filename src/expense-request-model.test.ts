import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleModelAsync } from './framework/testing.js';
import { actors } from './expenses/model-testing.js';
import { models, compareRequest, type RequestEvent } from './expenses/request-model-testing.js';

const model = models['expense-request-sqlite'];
test('generated expense requests compare replay identity, outcomes and current SQLite state', async () => {
  const reached = new Set<string>();
  for (const seed of [0, 42, 0xffffffff]) {
    const report = await sampleModelAsync({ ...model, seed,
      check: async (before, event, expected) => {
        reached.add(expected.output.kind);
        if (event.type === 'repeat') reached.add(event.alter);
        if (expected.output.kind === 'error') reached.add(expected.output.error);
        if (expected.output.kind === 'replayed' && expected.output.value.version < before.expense.version) reached.add('historical');
        return compareRequest(before, event, expected);
      },
    });
    assert.equal(report.kind, 'sampled', JSON.stringify(report)); assert.equal(report.transitions, 128);
  }
  for (const condition of ['committed', 'replayed', 'same', 'input', 'actor', 'actor-id', 'actor-role', 'target', 'operation', 'IdempotencyConflict', 'SaveConflict', 'historical']) {
    assert(reached.has(condition), condition);
  }
});

test('generated correction and approval episodes bind every applicable request identity field', async () => {
  const call = (type: 'submit' | 'approve' | 'return' | 'edit', actor: number, key: number): RequestEvent => ({
    type: 'call', key, stale: false, event: { type, actor: actors[actor]!, amount: 100001, receipt: true, reason: ' correction ' },
  });
  const episode: RequestEvent[] = [call('submit', 0, 0), call('return', 1, 1), call('edit', 0, 2),
    call('submit', 0, 3), call('approve', 1, 4), call('approve', 2, 5)];
  for (let receipt = 0; receipt < 6; receipt++) for (const alter of ['same', 'input', 'actor', 'actor-id', 'actor-role', 'target', 'operation'] as const) {
    episode.push({ type: 'repeat', receipt, alter });
  }
  episode.push({ type: 'repeat', receipt: 1, alter: 'reason' }, { type: 'repeat', receipt: 2, alter: 'amount' }, { type: 'repeat', receipt: 2, alter: 'receipt' });
  const reached = new Set<string>();
  const report = await sampleModelAsync({ ...model, seed: 42,
    initial: model.initial.filter(state => state.start.amount === 100001 && state.start.receipt),
    limits: { cases: 1, length: episode.length, shrinkAttempts: 200 },
    events: state => episode[state.history.length] ? [episode[state.history.length]!] : [],
    check: (before, event, expected) => {
      if (event.type === 'repeat') {
        reached.add(event.alter);
        assert.equal(expected.output.kind, event.alter === 'same' ? 'replayed' : 'error');
        if (expected.output.kind === 'error') assert.equal(expected.output.error, 'IdempotencyConflict');
        assert.equal(expected.state.expense.version, 7);
      }
      return compareRequest(before, event, expected);
    },
  });
  assert.equal(report.kind, 'sampled', JSON.stringify(report));
  assert.equal(report.transitions, 51);
  assert.equal(reached.size, 10);
});

test('request sequence shrinking detects a host that loses replay metadata', async () => {
  const report = await sampleModelAsync({ ...model, seed: 7,
    initial: model.initial.filter(state => state.start.amount === 3001 && state.start.receipt),
    limits: { cases: 1, length: 4, shrinkAttempts: 100 },
    events: state => [state.receipts.length ? { type: 'repeat', receipt: 0, alter: 'same' }
      : { type: 'call', key: 0, stale: false, event: { type: 'submit', actor: actors[0]!, amount: 1, receipt: true, reason: '' } }] as RequestEvent[],
    check: (before, event, expected) => compareRequest(before, event, expected, true),
  });
  assert(report.kind === 'counterexample' && report.reason === 'implementation', JSON.stringify(report));
  assert.equal(report.shrink, 'one-deletion-minimal');
  assert.deepEqual(report.witness.events.map(event => event.type), ['call', 'repeat']);
  assert.deepEqual(report.witness.events[1], { type: 'repeat', receipt: 0, alter: 'same' });
});
