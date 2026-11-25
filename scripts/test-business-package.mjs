// Build a PRIVATE local candidate containing the study API, never change/publish the real package.
import { mkdtempSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.stdout + result.stderr || String(result.error));
  return result.stdout;
}
const dir = mkdtempSync(join(tmpdir(), 'koyuki-business-consumer-'));
try {
  const candidate = join(dir, 'candidate'), consumer = join(dir, 'consumer');
  mkdirSync(candidate); mkdirSync(consumer);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const config = join(dir, 'tsconfig.candidate.json');
  writeFileSync(config, JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true,
    declaration: true, rootDir: join(root, 'src'), outDir: candidate, types: [], lib: ['ES2022', 'DOM'],
  }, files: [join(root, 'src/framework/index.ts'), join(root, 'src/experiments/business.ts')] }));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', config], root);
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ name: 'koyuki', version, private: true, type: 'module',
    exports: { '.': { types: './framework/index.d.ts', import: './framework/index.js' },
      './study': { types: './experiments/business.d.ts', import: './experiments/business.js' } },
    files: ['framework', 'experiments'],
  }));
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json'], candidate))[0].filename;
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
  pkg.dependencies.koyuki = `file:${join(candidate, packed)}`;
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
  const types = readFileSync(join(root, 'src/business-api-types.test.ts'), 'utf8')
    .replace("'./experiments/business.js'", "'koyuki/study'").replace("'./framework/index.js'", "'koyuki'");
  writeFileSync(join(consumer, 'business-types.ts'), types);
  console.log(run('npm', ['install', '--prefer-online', '--ignore-scripts', '--no-audit', '--no-fund'], consumer));
  console.log(run('npm', ['run', 'check'], consumer));
  console.log(run('npm', ['test'], consumer));
  writeFileSync(join(consumer, 'tsconfig.no-node.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true,
    noEmit: true, types: [], lib: ['ES2022', 'DOM'],
  }, files: ['business-types.ts'] }));
  console.log(run('npm', ['exec', '--', 'tsc', '-p', 'tsconfig.no-node.json'], consumer));

  copyFileSync(join(root, 'scripts/fixtures/leave-business-diagnostics.ts'), join(consumer, 'business-diagnostics.ts'));
  const result = spawnSync('npm', ['exec', '--', 'tsc', '--pretty', 'false'], { cwd: consumer, encoding: 'utf8' });
  const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || !result.status) throw new Error('Expected rejection of invalid business declarations');
  const lines = readFileSync(join(consumer, 'business-diagnostics.ts'), 'utf8').split('\n');
  const expected = lines.flatMap((line, index) => line.includes('// reject-next-line') ? [index + 2] : []);
  for (const line of expected) if (!diagnostics.includes(`business-diagnostics.ts(${line},`)) throw new Error(diagnostics);
  if (diagnostics.includes('TS7006') || diagnostics.includes('TS2305') || diagnostics.includes('TS2307')) throw new Error(diagnostics);
  console.log(`Verified ${expected.length} invalid business definitions rejected by installed candidate declarations.`);
  console.log('Verified unpublished business study: installed PRIVATE local candidate, leave HTTP/GraphQL/Application, parity and migration. No npm publication or supported public study export.');
} finally { rmSync(dir, { recursive: true, force: true }); }
