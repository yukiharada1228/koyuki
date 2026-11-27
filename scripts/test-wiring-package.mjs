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
  for (const file of ['authoring-wiring.test.tsx', 'authoring-wiring-contracts.test.tsx', 'authoring-wiring-sqlite.test.tsx']) {
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
    console.log(`TypeScript ${version}: installed needs, events, On, exact errors and declaration generation passed.`);
  }
  console.log(run('npm', ['start'], consumer).trim());
  console.log(run('npm', ['exec', '--', 'tsx', '--test', 'integration/authoring-wiring.test.tsx', 'integration/authoring-wiring-contracts.test.tsx', 'integration/authoring-wiring-sqlite.test.tsx'], consumer).trim());
  const runtime = join(consumer, 'node_modules/koyuki/dist/authoring.js'), source = readFileSync(runtime, 'utf8');
  const broken = source.replace('await route(report.publications)', 'await route([])'); assert.notEqual(source, broken);
  writeFileSync(runtime, broken);
  assert(run('npm', ['exec', '--', 'tsx', '--test', 'integration/authoring-wiring.test.tsx'], consumer, true).includes('fail'));
  console.log('Removing automatic event routing was rejected by the installed business tests.');
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
