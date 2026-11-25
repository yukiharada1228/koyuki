// Pack and install the actual development package; never publish to npm.
import { mkdtempSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { studyApprovalChange } from './studies/leave-approval-change.mjs';
import { studyAuthorizationChange } from './studies/leave-authorization-change.mjs';
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
  writeFileSync(join(consumer, 'audit.test.ts'), readFileSync(join(root, 'src/audit.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'async-transaction.test.ts'), readFileSync(join(root, 'src/async-transaction.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'transaction.test.ts'), readFileSync(join(root, 'src/transaction.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'process-observation.test.ts'), readFileSync(join(root, 'src/process-observation.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'process-detail.test.ts'), readFileSync(join(root, 'src/process-detail.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'fold-each.test.ts'), readFileSync(join(root, 'src/fold-each.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'collection-effects.test.ts'), readFileSync(join(root, 'src/collection-effects.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'workflow-observation.test.ts'), readFileSync(join(root, 'src/workflow-observation.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'replay-snapshot.test.ts'), readFileSync(join(root, 'src/replay-snapshot.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'opaque-decisions.test.ts'), readFileSync(join(root, 'src/opaque-decisions.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'business-save-inference.test.ts'), readFileSync(join(root, 'src/business-save-inference.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
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
  writeFileSync(join(consumer, 'transition-inference.test.ts'), readFileSync(join(root, 'src/transition-inference.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'").replace("'./examples/order-lines.js'", "'./order-lines.js'"));
  writeFileSync(join(consumer, 'order-lines.ts'), readFileSync(join(root, 'src/examples/order-lines.ts'), 'utf8').replace("'../framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'customer-import-sqlite.test.ts'), readFileSync(join(root, 'src/customer-import-sqlite.test.ts'), 'utf8').replace("'./framework/index.js'", "'koyuki'").replaceAll("'./examples/customer-import/", "'./customer-import/"));
  mkdirSync(join(consumer, 'procurement'));
  for (const file of ['domain.ts', 'repository.ts', 'application.ts', 'context.ts', 'context-process.ts', 'context-application.ts', 'comparison-contract.ts', 'plain.ts', 'helper.ts', 'trace-contract.ts', 'baseline-detail.ts', 'baseline-replay.ts', 'baseline-application.ts', 'inventory.ts', 'sqlite.ts', 'projection.ts', 'replay-identity.ts', 'replay.ts', 'current-projection.ts']) writeFileSync(join(consumer, 'procurement', file),
    readFileSync(join(root, 'src/experiments/procurement', file), 'utf8').replace("'../../framework/index.js'", "'koyuki'"));
  writeFileSync(join(consumer, 'procurement-load-composition.test.ts'), readFileSync(join(root, 'src/procurement-load-composition.test.ts'), 'utf8')
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
  writeFileSync(join(consumer, 'procurement-return-change.test.ts'), readFileSync(join(root, 'src/procurement-return-change.test.ts'), 'utf8')
    .replaceAll('./framework/index.js', 'koyuki').replaceAll('./experiments/procurement/', './procurement/'));
  writeFileSync(join(consumer, 'procurement-approval-change.test.ts'), readFileSync(join(root, 'src/procurement-approval-change.test.ts'), 'utf8')
    .replace("'./framework/index.js'", "'koyuki'").replaceAll("'./experiments/procurement/", "'./procurement/"));
  const types = readFileSync(join(root, 'src/business-api-types.test.ts'), 'utf8')
    .replace("'./experiments/business.js'", "'koyuki'").replace("'./framework/index.js'", "'koyuki'");
  writeFileSync(join(consumer, 'business-types.ts'), types);
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
  console.log(`Verified ${expected.length} invalid business definitions rejected by installed development declarations.`);
  if (process.argv.includes('--change')) {
    rmSync(join(consumer, 'business-diagnostics.ts'));
    studyApprovalChange(consumer, root, run);
    studyAuthorizationChange(consumer, root, run);
  }
  console.log('Verified public development business API from the actual packed package: leave HTTP/GraphQL/Application, parity and migration. No npm publication.');
} finally { rmSync(dir, { recursive: true, force: true }); }
