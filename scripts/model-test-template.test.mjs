import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateModelTest } from './generate-model-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const testing = new URL('../src/framework/testing.ts', import.meta.url).href;
const run = args => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 60000 });
};
function completed(source, broken = false) {
  return source
    .replace("throw new Error('TODO: independent event generator');", 'return [{ amount: -1 }, { amount: 0 }, { amount: 1 }];')
    .replace("throw new Error('TODO: independent reference specification');", 'return { state: { value: _before.value + _event.amount }, output: _before.value + _event.amount };')
    .replace("throw new Error('TODO: implementation comparison');", `
    // Independent adapter: initialized afresh even during counterexample shrinking.
    let stored = _before.value;
    const output = await Promise.resolve(stored += _event.amount${broken ? ' + 1' : ''});
    return output === _expected.output && stored === _expected.state.value;`);
}

test('generated test rejects placeholders, detects an implementation fault and rejects vacuous generators', async () => {
  const dir = await mkdtemp(join(root, '.model-template-test-'));
  try {
    const file = join(dir, 'business-model.test.ts');
    const source = generateModelTest().replace("'koyuki/testing'", JSON.stringify(testing));
    const execute = async content => {
      await writeFile(file, content);
      return run(['node_modules/tsx/dist/cli.mjs', '--test', file]);
    };
    const unfinished = await execute(source);
    assert.equal(unfinished.status, 1, unfinished.stderr);
    assert.match(unfinished.stdout, /TODO: independent event generator/);
    const correct = await execute(completed(source));
    assert.equal(correct.status, 0, correct.stdout + correct.stderr);
    assert.match(correct.stdout, /pass 3/);
    const broken = await execute(completed(source, true));
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stdout, /counterexample/);
    assert.match(broken.stdout, /witness/);
    const empty = await execute(completed(source).replace('return [{ amount: -1 }, { amount: 0 }, { amount: 1 }];', 'return [];'));
    assert.equal(empty.status, 1, empty.stderr);
    assert.match(empty.stdout, /No implementation comparison ran/);
    // Check the actual generated TypeScript, including the unfilled template.
    for (const content of [source, completed(source)]) {
      await writeFile(file, content.replace(JSON.stringify(testing), "'../src/framework/testing.js'"));
      const checked = run(['node_modules/typescript/bin/tsc', '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--types', 'node', '--target', 'es2022', '--module', 'nodenext', file]);
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI emits deterministic source only and rejects unsupported arguments', () => {
  const emitted = run(['scripts/generate-model-test.mjs']);
  assert.equal(emitted.status, 0); assert.equal(emitted.stdout, generateModelTest());
  assert.equal(emitted.stderr, '');
  const invalid = run(['scripts/generate-model-test.mjs', '--unknown']);
  assert.equal(invalid.status, 2); assert.equal(invalid.stdout, '');
});

test('contract generation never loads the module; generated tag tests run both adapters and expose stale-version faults', async () => {
  const dir = await mkdtemp(join(root, '.model-template-contract-'));
  try {
    const forbidden = join(dir, 'never-import.mjs');
    await writeFile(forbidden, "throw Error('GENERATION_EXECUTED_USER_CODE');");
    const emitted = run(['scripts/generate-model-test.mjs', '--contract', forbidden]);
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.equal(emitted.stdout, generateModelTest(forbidden));
    assert.equal(emitted.stderr, '');
    assert.throws(() => generateModelTest('bad\nmodule'), /Invalid model contract/);
    // Quotes in a specifier are encoded as source data, never interpolated as code.
    assert(generateModelTest("./it's-a-contract.js").includes(JSON.stringify("./it's-a-contract.js")));

    const contract = new URL('../src/tags/model-testing.ts', import.meta.url).href;
    const file = join(dir, 'generated.test.ts');
    const source = module => generateModelTest(module).replace("'koyuki/testing'", JSON.stringify(testing));
    await writeFile(file, source(contract));
    const healthy = run(['node_modules/tsx/dist/cli.mjs', '--test', file]);
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
    assert.match(healthy.stdout, /pass 6/);
    const faulty = join(dir, 'faulty.mjs');
    await writeFile(faulty, `import {models as healthy, compareTag, fixtures} from ${JSON.stringify(contract)};
export const models = { memory: { ...healthy.memory,
  check: (before, event, expected) => compareTag(fixtures.memory, before, event, expected, true)
} };`);
    await writeFile(file, source(faulty));
    const broken = run(['node_modules/tsx/dist/cli.mjs', '--test', file]);
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stdout, /counterexample/);
    assert.match(broken.stdout, /stale: true/);
    assert.match(broken.stdout, /one-deletion-minimal/);
    assert.match(broken.stdout, /witness/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generated expense tests use independent approval rules and detect a forged actor adaptation', async () => {
  const dir = await mkdtemp(join(root, '.model-template-expense-'));
  try {
    const contract = new URL('../src/expenses/model-testing.ts', import.meta.url).href;
    const file = join(dir, 'generated.test.ts');
    const source = module => generateModelTest(module).replace("'koyuki/testing'", JSON.stringify(testing));
    await writeFile(file, source(contract));
    const healthy = run(['node_modules/tsx/dist/cli.mjs', '--test', file]);
    assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
    assert.match(healthy.stdout, /pass 3/);
    const faulty = join(dir, 'faulty.mjs');
    await writeFile(faulty, `import { models as healthy, matchesImplementation, actual } from ${JSON.stringify(contract)};
export const models = { 'expense-domain': { ...healthy['expense-domain'],
  check: (before, event, expected) => matchesImplementation(before, event, expected,
    (state, operation) => actual(state, operation.type === 'approve' && operation.actor.id === state.owner
      ? { ...operation, actor: { id: 'forged-actor', role: 'manager', active: true } } : operation))
} };`);
    await writeFile(file, source(faulty));
    const broken = run(['node_modules/tsx/dist/cli.mjs', '--test', file]);
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stdout, /counterexample/);
    assert.match(broken.stdout, /witness/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
