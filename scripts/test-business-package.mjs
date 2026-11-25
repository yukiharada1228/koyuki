// Pack and install the actual development package; never publish to npm.
import { mkdtempSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { studyApprovalChange } from './studies/leave-approval-change.mjs';
import { studyAuthorizationChange } from './studies/leave-authorization-change.mjs';
import { generateModelTest } from './generate-model-test.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.stdout + result.stderr || String(result.error));
  return result.stdout;
}
const dir = mkdtempSync(join(tmpdir(), 'koyuki-business-consumer-'));
try {
  const consumer = join(dir, 'consumer');
  mkdirSync(consumer);
  // Compile the unfilled scaffold against installed declarations; it must not
  // enter the passing runtime suite until its independent specification exists.
  writeFileSync(join(consumer, 'model-template.ts'), generateModelTest());
  run('npm', ['run', 'build'], root);
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', dir, '--ignore-scripts', '--json'], root))[0].filename;
  const source = join(root, 'examples/leave-http');
  for (const file of readdirSync(source).filter(file => file.endsWith('.ts') || ['package.json', 'tsconfig.json'].includes(file))) copyFileSync(join(source, file), join(consumer, file));
  copyFileSync(join(consumer, 'application.ts'), join(consumer, 'application-named.ts'));
  for (const [from, to] of [
    ['leave-business-application.ts', 'application.ts'],
    ['leave-business-parity.test.ts', 'business-parity.test.ts'],
    ['leave-application-lifecycle.test.ts', 'application-lifecycle.test.ts'],
    ['leave-business-migration.test.ts', 'business-migration.test.ts'],
  ]) copyFileSync(join(root, 'scripts/fixtures', from), join(consumer, to));
  const pkg = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'));
  pkg.dependencies.koyuki = `file:${join(dir, packed)}`;
  pkg.scripts.test = 'tsx --test *.test.ts';
  writeFileSync(join(consumer, 'package.json'), JSON.stringify(pkg));
  // The HTTP contract is unchanged; only the two explicit domain trace labels differ.
  const httpTest = join(consumer, 'http.test.ts');
  let httpSource = readFileSync(httpTest, 'utf8');
  for (const [before, after] of [["step: 'require-days'", "step: 'run:2'"], ["entry.step === 'submit'", "entry.step === 'run:3'"]]) {
    if (httpSource.split(before).length !== 2) throw new Error(`Expected one trace assertion: ${before}`);
    httpSource = httpSource.replace(before, after);
  }
  writeFileSync(httpTest, httpSource);
  writeFileSync(join(consumer, 'detailed-load.test.ts'), readFileSync(join(root, 'src/detailed-load.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'live-execution.test.ts'), readFileSync(join(root, 'src/live-execution.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'finite-model.test.ts'), readFileSync(join(root, 'src/finite-model.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  writeFileSync(join(consumer, 'model-sequences.test.ts'), readFileSync(join(root, 'src/model-sequences.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  mkdirSync(join(consumer, 'tags'), { recursive: true });
  mkdirSync(join(consumer, 'adapters'), { recursive: true });
  for (const file of ['tags/domain.ts', 'tags/events.ts', 'tags/model.ts', 'tags/repository.ts', 'tags/identity.ts', 'tags/sqlite.ts', 'tags/lifecycle.ts', 'tags/model-testing.ts', 'tags/replay-model-testing.ts', 'adapters/sqlite-audit.ts']) {
    writeFileSync(join(consumer, file), readFileSync(join(root, 'src', file), 'utf8').replaceAll("'../framework/index.js'", "'koyuki'").replaceAll("'../framework/result.js'", "'koyuki'").replaceAll("'../framework/testing.js'", "'koyuki/testing'"));
  }
  writeFileSync(join(consumer, 'generated-tag-model.test.ts'), generateModelTest('./tags/model-testing.js'));
  writeFileSync(join(consumer, 'generated-tag-replay-model.test.ts'), generateModelTest('./tags/replay-model-testing.js'));
  writeFileSync(join(consumer, 'tag-replay-model.test.ts'), readFileSync(join(root, 'src/tag-replay-model.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  writeFileSync(join(consumer, 'tag-model-sequences.test.ts'), readFileSync(join(root, 'src/tag-model-sequences.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  writeFileSync(join(consumer, 'retry.test.ts'), readFileSync(join(root, 'src/retry.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-operation-table.test.ts'), readFileSync(join(root, 'src/business-operation-table.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'expense-state-exploration.test.ts'), readFileSync(join(root, 'src/expense-state-exploration.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'").replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'expense-model-adoption.test.ts'), readFileSync(join(root, 'src/expense-model-adoption.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  mkdirSync(join(consumer, 'expenses'));
  mkdirSync(join(consumer, 'examples'), { recursive: true });
  for (const file of ['expenses/domain.ts', 'expenses/application.ts', 'expenses/repository.ts', 'expenses/sqlite.ts', 'expenses/sqlite-replay.ts', 'expenses/replay.ts', 'expenses/model-testing.ts', 'expenses/request-model-testing.ts', 'expenses/race-model-testing.ts', 'examples/expense.ts']) {
    writeFileSync(join(consumer, file), readFileSync(join(root, 'src', file), 'utf8').replaceAll("'../framework/index.js'", "'koyuki'").replaceAll("'../framework/testing.js'", "'koyuki/testing'"));
  }
  writeFileSync(join(consumer, 'generated-expense-model.test.ts'), generateModelTest('./expenses/model-testing.js'));
  writeFileSync(join(consumer, 'generated-expense-request-model.test.ts'), generateModelTest('./expenses/request-model-testing.js'));
  writeFileSync(join(consumer, 'expense-request-model.test.ts'), readFileSync(join(root, 'src/expense-request-model.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  writeFileSync(join(consumer, 'generated-expense-race-model.test.ts'), generateModelTest('./expenses/race-model-testing.js'));
  writeFileSync(join(consumer, 'expense-race-model.test.ts'), readFileSync(join(root, 'src/expense-race-model.test.ts'), 'utf8').replace("'./framework/testing.js'", "'koyuki/testing'"));
  writeFileSync(join(consumer, 'expense-replay-version.test.ts'), readFileSync(join(root, 'src/expense-replay-version.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  mkdirSync(join(consumer, 'shipping'));
  for (const file of ['domain.ts', 'feature.ts']) writeFileSync(join(consumer, 'shipping', file),
    readFileSync(join(root, 'src/shipping', file), 'utf8').replaceAll("'../framework/index.js'", "'koyuki'"));
  for (const file of ['shipping.test.ts', 'flow-examples.test.ts', 'model-unions.test.ts']) writeFileSync(join(consumer, file),
    readFileSync(join(root, 'src', file), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'declaration-ownership.test.ts'), readFileSync(join(root, 'src/declaration-ownership.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'flow-structure.test.ts'), readFileSync(join(root, 'src/flow-structure.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'application-input-contract.test.ts'), readFileSync(join(root, 'src/application-input-contract.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'application-operation-table.test.ts'), readFileSync(join(root, 'src/application-operation-table.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'application-execution.test.ts'), readFileSync(join(root, 'src/application-execution.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'program-execution.test.ts'), readFileSync(join(root, 'src/program-execution.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'subscription-rejection.test.ts'), readFileSync(join(root, 'src/subscription-rejection.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'capture-rejection.test.ts'), readFileSync(join(root, 'src/capture-rejection.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'audit.test.ts'), readFileSync(join(root, 'src/audit.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'async-transaction.test.ts'), readFileSync(join(root, 'src/async-transaction.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'transaction.test.ts'), readFileSync(join(root, 'src/transaction.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'process-observation.test.ts'), readFileSync(join(root, 'src/process-observation.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'process-projection.test.ts'), readFileSync(join(root, 'src/process-projection.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'process-detail.test.ts'), readFileSync(join(root, 'src/process-detail.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'fold-each.test.ts'), readFileSync(join(root, 'src/fold-each.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'collection-effects.test.ts'), readFileSync(join(root, 'src/collection-effects.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'workflow-observation.test.ts'), readFileSync(join(root, 'src/workflow-observation.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'replay-snapshot.test.ts'), readFileSync(join(root, 'src/replay-snapshot.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'opaque-decisions.test.ts'), readFileSync(join(root, 'src/opaque-decisions.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-save-inference.test.ts'), readFileSync(join(root, 'src/business-save-inference.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-replay-context.test.ts'), readFileSync(join(root, 'src/business-replay-context.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-observation.test.ts'), readFileSync(join(root, 'src/business-observation.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  mkdirSync(join(consumer, 'customer-import'));
  for (const file of ['domain.ts', 'application.ts', 'sqlite.ts']) writeFileSync(join(consumer, 'customer-import', file),
    readFileSync(join(root, 'src/examples/customer-import', file), 'utf8').replace("'../../framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'customer-import.test.ts'), readFileSync(join(root, 'src/customer-import.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./examples/customer-import/", "'./customer-import/"));
  writeFileSync(join(consumer, 'branch-narrowing.test.ts'), readFileSync(join(root, 'src/branch-narrowing.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'workflow-input.test.ts'), readFileSync(join(root, 'src/workflow-input.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'application-ownership.test.ts'), readFileSync(join(root, 'src/application-ownership.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'application-receiver.test.ts'), readFileSync(join(root, 'src/application-receiver.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'combine.test.ts'), readFileSync(join(root, 'src/combine.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'collect-fields.test.ts'), readFileSync(join(root, 'src/collect-fields.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'transition-inference.test.ts'), readFileSync(join(root, 'src/transition-inference.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'").replace("'./examples/order-lines.js'", "'./order-lines.js'"));
  writeFileSync(join(consumer, 'order-lines.ts'), readFileSync(join(root, 'src/examples/order-lines.ts'), 'utf8').replace("'../framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'customer-import-sqlite.test.ts'), readFileSync(join(root, 'src/customer-import-sqlite.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'").replaceAll("'./examples/customer-import/", "'./customer-import/"));
  mkdirSync(join(consumer, 'procurement'));
  for (const file of ['domain.ts', 'repository.ts', 'application.ts', 'context.ts', 'context-framework.ts', 'context-process.ts', 'context-application.ts', 'comparison-scenario.ts', 'comparison-contract.ts', 'plain.ts', 'helper.ts', 'trace-contract.ts', 'baseline-detail.ts', 'baseline-replay.ts', 'baseline-application.ts', 'inventory.ts', 'sqlite.ts', 'projection.ts', 'replay-identity.ts', 'replay.ts', 'current-projection.ts']) writeFileSync(join(consumer, 'procurement', file),
    readFileSync(join(root, 'src/experiments/procurement', file), 'utf8').replace("'../../framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'procurement-load-composition.test.ts'), readFileSync(join(root, 'src/procurement-load-composition.test.ts'), 'utf8')
    .replaceAll('./framework/index.js', 'koyuki').replaceAll('./experiments/procurement/', './procurement/'));
  writeFileSync(join(consumer, 'procurement-framework-context.test.ts'), readFileSync(join(root, 'src/procurement-framework-context.test.ts'), 'utf8')
    .replaceAll('./framework/index.js', 'koyuki').replaceAll('./experiments/procurement/', './procurement/'));
  writeFileSync(join(consumer, 'procurement.test.ts'), readFileSync(join(root, 'src/procurement.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-sqlite.test.ts'), readFileSync(join(root, 'src/procurement-sqlite.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-projection.test.ts'), readFileSync(join(root, 'src/procurement-projection.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-replay.test.ts'), readFileSync(join(root, 'src/procurement-replay.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-comparison.test.ts'), readFileSync(join(root, 'src/procurement-comparison.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-trace-comparison.test.ts'), readFileSync(join(root, 'src/procurement-trace-comparison.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-replay-comparison.test.ts'), readFileSync(join(root, 'src/procurement-replay-comparison.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-application-comparison.test.ts'), readFileSync(join(root, 'src/procurement-application-comparison.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-current-projection.test.ts'), readFileSync(join(root, 'src/procurement-current-projection.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-current-comparison.test.ts'), readFileSync(join(root, 'src/procurement-current-comparison.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-observation-comparison.test.ts'), readFileSync(join(root, 'src/procurement-observation-comparison.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-observation-scenario.test.ts'), readFileSync(join(root, 'src/procurement-observation-scenario.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  writeFileSync(join(consumer, 'procurement-shared-guards.test.ts'), readFileSync(join(root, 'src/procurement-shared-guards.test.ts'), 'utf8').replaceAll('./framework/index.js', 'koyuki').replaceAll('./experiments/procurement/', './procurement/'));
  writeFileSync(join(consumer, 'procurement-order-guard.test.ts'), readFileSync(join(root, 'src/procurement-order-guard.test.ts'), 'utf8').replaceAll('./framework/index.js', 'koyuki').replaceAll('./experiments/procurement/', './procurement/'));
  writeFileSync(join(consumer, 'procurement-return-change.test.ts'), readFileSync(join(root, 'src/procurement-return-change.test.ts'), 'utf8')
    .replaceAll('./framework/index.js', 'koyuki').replaceAll('./experiments/procurement/', './procurement/'));
  writeFileSync(join(consumer, 'procurement-approval-change.test.ts'), readFileSync(join(root, 'src/procurement-approval-change.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  const types = readFileSync(join(root, 'src/business-api-types.test.ts'), 'utf8')
    .replace("'./experiments/business.js'", "'koyuki'").replace("'./framework/index.js'", "'koyuki'");
  writeFileSync(join(consumer, 'business-types.ts'), types);
  writeFileSync(join(consumer, 'business-generic-proof.test.ts'), readFileSync(join(root, 'src/business-generic-proof.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-generic-check.test.ts'), readFileSync(join(root, 'src/business-generic-check.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-generic-load.test.ts'), readFileSync(join(root, 'src/business-generic-load.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'transition-inline-step.test.ts'), readFileSync(join(root, 'src/transition-inline-step.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  const quickstart = readFileSync(join(root, 'docs/business.md'), 'utf8').split('```ts\n')[1].split('```')[0];
  writeFileSync(join(consumer, 'business-quickstart.ts'), quickstart);
  console.log(run('npm', ['install', '--prefer-online', '--ignore-scripts', '--no-audit', '--no-fund'], consumer));
  console.log(run('npm', ['run', 'check'], consumer));
  console.log(run('npm', ['test'], consumer));
  console.log(run('npm', ['exec', '--', 'tsx', 'business-quickstart.ts'], consumer));
  writeFileSync(join(consumer, 'tsconfig.no-node.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true,
    noEmit: true, types: [], lib: ['ES2022', 'DOM'],
  }, files: ['business-types.ts', 'business-quickstart.ts'] }));
  console.log(run('npm', ['exec', '--', 'tsc', '-p', 'tsconfig.no-node.json'], consumer));

  copyFileSync(join(root, 'scripts/fixtures/leave-business-diagnostics.ts'), join(consumer, 'business-diagnostics.ts'));
  const result = spawnSync('npm', ['exec', '--', 'tsc', '--pretty', 'false'], { cwd: consumer, encoding: 'utf8' });
  const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || !result.status) throw new Error('Expected rejection of invalid business declarations');
  const lines = readFileSync(join(consumer, 'business-diagnostics.ts'), 'utf8').split('\n');
  const expected = lines.flatMap((line, index) => line.includes('// reject-next-line') ? [index + 2] : []);
  for (const line of expected) if (!diagnostics.includes(`business-diagnostics.ts(${line},`)) throw new Error(diagnostics);
  if (diagnostics.includes('TS7006') || diagnostics.includes('TS2305') || diagnostics.includes('TS2307')) throw new Error(diagnostics);
  for (const marker of [
    'Koyuki: wrongFirst[0] input must accept prior output',
    'Koyuki: omittedPermission[1] input must accept prior output',
    'Koyuki: wrongSave[1] output must match save',
    'Koyuki: overridden[0] input must accept prior output',
    'Koyuki: 0[0] input must accept prior output',
  ]) if (!diagnostics.includes(marker)) throw new Error(`Missing stage-location diagnostic: ${marker}\n${diagnostics}`);
  console.log(`Verified ${expected.length} invalid business definitions rejected by installed development declarations.`);
  if (process.argv.includes('--change')) {
    rmSync(join(consumer, 'business-diagnostics.ts'));
    studyApprovalChange(consumer, root, run);
    studyAuthorizationChange(consumer, root, run);
  }
  console.log('Verified public development business API from the actual packed package: leave HTTP/GraphQL/Application, parity and migration. No npm publication.');
} finally { rmSync(dir, { recursive: true, force: true }); }
