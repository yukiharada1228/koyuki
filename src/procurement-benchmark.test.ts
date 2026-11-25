import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { story } from './experiments/procurement/comparison-scenario.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import type { StudyFactory } from './experiments/procurement/comparison-contract.js';
import { err } from './framework/index.js';

test('benchmark smoke covers both backends and three styles, records provenance, and avoids speed thresholds', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/experiments/procurement/benchmark.ts', '--rounds', '2', '--iterations', '1', '--warmup', '0', '--backend', 'both'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.schema, 'koyuki.procurement-runtime.v1'); assert.equal(report.results.length, 2);
  assert.match(report.source.gitCommit, /^[a-f0-9]{40}$/);
  assert(report.source.hashes['src/framework/business.ts']);
  assert.deepEqual(report.results.map((result: { backend: string }) => result.backend), ['memory', 'sqlite']);
  for (const result of report.results) {
    assert.equal(result.distinctOperations, 25); assert.equal(result.scenarioOperations, 32);
    for (const style of ['plain', 'helper', 'koyuki']) {
      const measured = result.perStyle[style]; assert.equal(measured.measuredScenarios, 2);
      for (const metric of ['constructionMs', 'executionMs']) {
        assert.equal(measured.rawRoundMeans[metric].length, 2);
        assert(measured.rawRoundMeans[metric].every((value: number) => Number.isFinite(value) && value >= 0));
      }
    }
  }
});

test('a failed operation cannot earn a completed scenario timing', async () => {
  const failing: StudyFactory = (...args) => {
    const commands = plainProcurement(...args);
    return { ...commands, requests: { ...commands.requests, create: async (..._input: Parameters<typeof commands.requests.create>) => err({ kind: 'NotFound' as const }) } };
  };
  let constructed = false, completed = false;
  await assert.rejects(story(failing, new MemoryProcurement(), { constructed: () => { constructed = true; }, executed: () => { completed = true; } }), /request.create/);
  assert(constructed); assert(!completed);
});
