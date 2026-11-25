import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Source generation only: never import or execute the business being tested. */
export function generateModelTest(contract) {
  if (contract !== undefined) {
    if (typeof contract !== 'string' || !contract.trim() || /[\r\n\0]/.test(contract)) throw new TypeError('Invalid model contract module');
    return `import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { sampleModelAsync } from 'koyuki/testing';
import { models } from ${JSON.stringify(contract)};

// models supplies independent specifications and isolated implementation checks.
// Generation never imports that module. These callbacks run only during testing.
assert(Object.keys(models).length > 0, 'No model contracts supplied');
for (const [name, model] of Object.entries(models)) {
  for (const seed of [0, 42, 0xffffffff]) test(name + ', seed ' + seed, async () => {
    const report = await sampleModelAsync({ ...model, seed });
    assert.equal(report.kind, 'sampled', inspect(report, { depth: null }));
    assert(report.transitions > 0, 'No implementation comparison ran; check the generator');
    // sampled is bounded evidence, not exhaustive correctness.
  });
}
`;
  }
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { sampleModelAsync, type AsyncSequenceModel } from 'koyuki/testing';

// Replace these example shapes and initial states with your business specification.
type State = { readonly value: number };
type Event = { readonly amount: number };
type Output = number;

const model: Omit<AsyncSequenceModel<State, Event, Output>, 'seed'> = {
  initial: [{ value: 0 }],
  limits: { cases: 20, length: 20, shrinkAttempts: 200 },
  events: (_state, _random) => {
    // Include boundaries, invalid inputs, permissions and stale versions as appropriate.
    // Use only _random for random generation; do not exclude legitimate rejections.
    throw new Error('TODO: independent event generator');
  },
  step: (_before, _event) => {
    // Calculate expected state AND output from an independent business specification.
    // Do not call the implementation, its validators or its state transitions here.
    throw new Error('TODO: independent reference specification');
  },
  check: async (_before, _event, _expected) => {
    // Reconstruct isolated implementation state from _before on EVERY call.
    // Execute the operation and compare its output AND saved state to _expected.
    // Close/rollback the fixture in finally. Shrinking also invokes this callback.
    throw new Error('TODO: implementation comparison');
  },
  // Optional: invariant, shrinkEvent and shrinkInitial must come from the specification.
};

for (const seed of [0, 42, 0xffffffff]) test('business model, seed ' + seed, async () => {
  const report = await sampleModelAsync({ ...model, seed });
  // Explicit test diagnostics can contain business data. Keep fixtures synthetic.
  assert.equal(report.kind, 'sampled', inspect(report, { depth: null }));
  assert(report.transitions > 0, 'No implementation comparison ran; check the generator');
  // sampled means no counterexample in this bounded run, not exhaustive correctness.
});
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--contract' && args[1].trim() && !/[\r\n\0]/.test(args[1]))) {
    console.error('Usage: node scripts/generate-model-test.mjs [--contract ./model-contract.js] > business-model.test.ts');
    process.exitCode = 2;
  } else process.stdout.write(generateModelTest(args[1]));
}
