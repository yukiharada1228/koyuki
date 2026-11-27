import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), verify = args.length === 0 || (args.length === 1 && args[0] === '--verify');
assert(verify || (args.length === 2 && args[0] === '--prepare'), 'Use --verify or --prepare /unused/path');
function run(command, args, cwd = root, fail = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert(!result.error && result.status !== null && (fail ? result.status !== 0 : result.status === 0), output || String(result.error));
  return output;
}
const temp = mkdtempSync(join(tmpdir(), 'koyuki-wiring-package-'));
try {
  const consumer = verify ? join(temp, 'consumer') : resolve(args[1]);
  assert(!existsSync(consumer), 'Refusing to overwrite an existing directory');
  run('npm', ['run', 'build']);
  const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp]))[0];
  mkdirSync(consumer); copyFileSync(join(temp, pack.filename), join(consumer, 'koyuki-development.tgz'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { check: 'tsc --noEmit', start: 'tsx connected/demo.tsx', test: 'tsx --test integration/*.test.tsx' }, dependencies: { koyuki: 'file:./koyuki-development.tgz' }, devDependencies: { typescript: '7.0.2', tsx: '4.23.15' } }, null, 2));
  const options = JSON.parse(readFileSync(join(root, 'examples/authoring-quickstart/tsconfig.json'), 'utf8')); options.compilerOptions.rootDir = '.'; options.include = ['connected/*.ts', 'connected/*.tsx'];
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(options));
  writeFileSync(join(consumer, 'README.md'), '# Declarative connections demo\n\nUnpublished development package; not npm alpha.5. Run npm install, npm run check, npm start and npm test. Node.js 26 is used for SQLite integration tests. connected/business.tsx contains the reusable business components. This demo sends no real email.\n');
  mkdirSync(join(consumer, 'connected')); mkdirSync(join(consumer, 'integration'));
  for (const file of ['business.tsx', 'domain.ts', 'memory.ts', 'demo.tsx']) {
    const source = readFileSync(join(root, 'src/experiments/declarative-booking', file), 'utf8')
      .replaceAll("'../../framework/index.js'", "'koyuki'").replaceAll("'../../framework/authoring.js'", "'koyuki/experimental'");
    writeFileSync(join(consumer, 'connected', file), source);
  }
  copyFileSync(join(root, 'scripts/fixtures/authoring-wiring-contracts.tsx'), join(consumer, 'connected/contracts.tsx'));
  for (const file of ['authoring-wiring.test.tsx', 'authoring-wiring-contracts.test.tsx', 'authoring-wiring-sqlite.test.tsx', 'authoring-view.test.tsx', 'authoring-refresh.test.tsx']) {
    const source = readFileSync(join(root, 'src', file), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'").replaceAll("'./framework/authoring.js'", "'koyuki/experimental'")
      .replaceAll("'./experiments/declarative-booking/business.js'", "'../connected/business.js'")
      .replaceAll("'./experiments/declarative-booking/domain.js'", "'../connected/domain.js'")
      .replaceAll("'./experiments/declarative-booking/sqlite.js'", "'./sqlite.mjs'");
    writeFileSync(join(consumer, 'integration', file), source);
  }
  // Host SQLite adapter only; the engine must resolve from the installed package.
  const bundle = await build({ entryPoints: [join(root, 'src/experiments/declarative-booking/sqlite.ts')], outfile: join(consumer, 'integration/sqlite.mjs'), bundle: true, platform: 'node', format: 'esm', metafile: true,
    plugins: [{ name: 'installed-core', setup(builder) { builder.onResolve({ filter: /framework\/index\.js$/ }, () => ({ path: 'koyuki', external: true })); } }] });
  assert(!Object.keys(bundle.metafile.inputs).some(file => file.includes('src/framework/')));
  const configFile = join(consumer, 'tsconfig.json'), config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.include.push('connected/*.ts', 'connected/*.tsx'); writeFileSync(configFile, JSON.stringify(config));
  if (!verify) { console.log(`Prepared ${consumer}. Run npm install, npm run check, npm start and npm test. No npm publication performed.`); }
  else {
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const name of ['react', '@types/react', '@types/node']) assert(!existsSync(join(consumer, 'node_modules', name)), `Unexpected dependency: ${name}`);
  for (const version of ['7.0.2', '6.0.3']) {
    if (version !== '7.0.2') run('npm', ['install', '--save-dev', `typescript@${version}`, '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    run('npm', ['run', 'check'], consumer);
    const emit = { ...config, compilerOptions: { ...config.compilerOptions, noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: './declarations' } };
    writeFileSync(join(consumer, 'emit.json'), JSON.stringify(emit)); run('npm', ['exec', '--', 'tsc', '-p', 'emit.json'], consumer);
    writeFileSync(join(consumer, 'declaration-client.ts'), `import { session } from './declarations/connected/contracts.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const snapshot = session.snapshot();
const exact: Equal<typeof snapshot.view.error, 'Missing' | 'Offline' | null> = true; void exact;
if (false) {
  // @ts-expect-error Inferred session input survives exported declarations.
  void session.dispatch({ type: 'change', input: {} });
}
`);
    writeFileSync(join(consumer, 'declaration-client.json'), JSON.stringify({ compilerOptions: config.compilerOptions, files: ['declaration-client.ts'] }));
    run('npm', ['exec', '--', 'tsc', '-p', 'declaration-client.json'], consumer);
    console.log(`TypeScript ${version}: resources, events, lifecycle/view contracts and generated-declaration consumer passed.`);
  }
  console.log(run('npm', ['start'], consumer).trim());
  console.log(run('npm', ['exec', '--', 'tsx', '--test', 'integration/authoring-wiring.test.tsx', 'integration/authoring-wiring-contracts.test.tsx', 'integration/authoring-wiring-sqlite.test.tsx', 'integration/authoring-view.test.tsx', 'integration/authoring-refresh.test.tsx'], consumer).trim());
  const runtime = join(consumer, 'node_modules/koyuki/dist/authoring.js'), source = readFileSync(runtime, 'utf8');
  const viewRuntime = join(consumer, 'node_modules/koyuki/dist/authoring-view.js'), viewSource = readFileSync(viewRuntime, 'utf8');
  const unprojected = viewSource.replace('reduce(snapshotData(state.data), snapshotData(result.value))', 'snapshotData(state.data)'); assert.notEqual(viewSource, unprojected);
  try {
    writeFileSync(viewRuntime, unprojected);
    const refused = run('npm', ['exec', '--', 'tsx', '--test', 'integration/authoring-view.test.tsx'], consumer, true);
    assert(refused.includes('fail'));
  } finally { writeFileSync(viewRuntime, viewSource); }
  console.log('Removing presentation projection was rejected by installed lifecycle tests.');
  const unrefreshed = viewSource.replace('return ok(withRefresh(completed, names));', 'return ok(withRefresh(completed, []));'); assert.notEqual(viewSource, unrefreshed);
  try {
    writeFileSync(viewRuntime, unrefreshed);
    assert(run('npm', ['exec', '--', 'tsx', '--test', 'integration/authoring-refresh.test.tsx'], consumer, true).includes('fail'));
  } finally { writeFileSync(viewRuntime, viewSource); }
  console.log('Removing automatic query refresh was rejected by installed event-to-view tests.');
  const broken = source.replace('await route(report.publications)', 'await route([])'); assert.notEqual(source, broken);
  writeFileSync(runtime, broken);
  assert(run('npm', ['exec', '--', 'tsx', '--test', 'integration/authoring-wiring.test.tsx'], consumer, true).includes('fail'));
  console.log('Removing automatic event routing was rejected by the installed business tests.');
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
