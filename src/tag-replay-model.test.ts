import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleModelAsync } from './framework/testing.js';
import { fixtures } from './tags/model-testing.js';
import { models, compareReplay, type ReplayEvent } from './tags/replay-model-testing.js';

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`generated tag snapshot replay compares unchanged, stale and changed snapshots for ${name}`, async () => {
    const reached = new Set<string>();
    for (const seed of [0, 42, 0xffffffff]) {
      const report = await sampleModelAsync({ ...models[name]!, seed,
        check: async (before, event, expected) => {
          if (event.type === 'repeat') reached.add(event.changed ? 'changed' : expected.output.kind === 'saved' ? 'same' : 'stale');
          return compareReplay(fixture, before, event, expected);
        },
      });
      assert.equal(report.kind, 'sampled', JSON.stringify(report));
      assert.equal(report.transitions, 128);
    }
    assert.deepEqual([...reached].sort(), ['changed', 'same', 'stale']);
  });

  test(`replay shrinking retains the original change and changed-snapshot reproduction for ${name}`, async () => {
    let opened = 0, closed = 0;
    const isolated = () => {
      const adapter = fixture(); opened++;
      return { ...adapter, close() { adapter.close(); closed++; } };
    };
    const report = await sampleModelAsync({ ...models[name]!, seed: 7,
      limits: { cases: 1, length: 4, shrinkAttempts: 100 },
      events: state => [state.receipts.length ? { type: 'repeat', receipt: 0, changed: true }
        : { type: 'change', change: { type: 'create', slot: 0, label: 'A', stale: false } }] as ReplayEvent[],
      check: (before, event, expected) => compareReplay(isolated, before, event, expected, true),
    });
    assert(report.kind === 'counterexample' && report.reason === 'implementation', JSON.stringify(report));
    assert.equal(report.shrink, 'one-deletion-minimal');
    assert.deepEqual(report.witness.events.map(event => event.type), ['change', 'repeat']);
    assert.deepEqual(report.witness.events[1], { type: 'repeat', receipt: 0, changed: true });
    assert.equal(opened, closed); assert(opened > 2);
  });
}
