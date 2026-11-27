import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd = root, fail = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert(!result.error && result.status !== null && (fail ? result.status !== 0 : result.status === 0), output || String(result.error));
  return output;
}
const temp = mkdtempSync(join(tmpdir(), 'koyuki-authoring-change-'));
try {
  const consumer = join(temp, 'consumer');
  run(process.execPath, ['scripts/test-authoring-package.mjs', '--prepare', consumer]);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const dependency of ['react', '@types/node']) assert(!existsSync(join(consumer, 'node_modules', dependency)));
  const configFile = join(consumer, 'tsconfig.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.include.push('cancellation.tsx');
  writeFileSync(configFile, JSON.stringify(config));
  for (const name of ['authoring-cancellation-trial', 'authoring-cancellation-deadline']) {
    copyFileSync(join(root, 'scripts/fixtures', `${name}.tsx`), join(consumer, 'cancellation.tsx'));
    run('npm', ['run', 'check'], consumer);
    console.log(run('npm', ['exec', '--', 'tsx', 'cancellation.tsx'], consumer).trim());
  }
  const source = readFileSync(join(consumer, 'cancellation.tsx'), 'utf8');
  const strictBoundary = source.replace('value.booking.startsAt - value.now >= day', 'value.booking.startsAt - value.now > day');
  assert.notEqual(source, strictBoundary);
  writeFileSync(join(consumer, 'cancellation.tsx'), strictBoundary);
  run('npm', ['run', 'check'], consumer);
  assert(run('npm', ['exec', '--', 'tsx', 'cancellation.tsx'], consumer, true).includes('DeadlineBoundaryMustAllow'));
  console.log('Type-correct exclusive-boundary mutation was rejected by the business test.');
  writeFileSync(join(consumer, 'cancellation.tsx'), source.replace('now: clock()', 'now: clock'));
  assert(run('npm', ['run', 'check'], consumer, true).includes('TS'));
  console.log('A clock function passed instead of a time value was rejected by type checking.');
  writeFileSync(join(consumer, 'cancellation.tsx'), source);
  // Change only the policy threshold after the new dependency is established.
  writeFileSync(join(consumer, 'cancellation.tsx'), source.replace('value.booking.startsAt - value.now >= day', 'value.booking.startsAt - value.now >= 2 * day').replaceAll('startsAt - day', 'startsAt - 2 * day').replace("['one', 'owner', startsAt, 'CancellationClosed'],", "['one', 'owner', startsAt - day, 'CancellationClosed'],\n  ['one', 'owner', startsAt, 'CancellationClosed'],"));
  run('npm', ['run', 'check'], consumer);
  console.log(run('npm', ['exec', '--', 'tsx', 'cancellation.tsx'], consumer).trim());
  console.log('24h -> 48h policy-only change passed with the same Hook, Provider, registration and executor.');
} finally { rmSync(temp, { recursive: true, force: true }); }
