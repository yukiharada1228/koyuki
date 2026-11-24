import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.stdout + result.stderr || String(result.error));
  return result.stdout;
}
const registry = process.argv.includes('--registry');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const packed = registry ? null : JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json']))[0];
const dependency = registry ? version : `file:${join(root, packed.filename)}`;
const temp = mkdtempSync(join(tmpdir(), 'koyuki-runtime-contract-'));
try {
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { koyuki: dependency } }));
  run('npm', ['install', '--prefer-online', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], temp);
  const installed = join(temp, 'node_modules/koyuki');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(Object.keys(manifest[key] ?? {}).length, 0, `${key} must be empty`);
  for (const key of ['bundledDependencies', 'bundleDependencies']) assert(manifest[key] === undefined || manifest[key] === false || (Array.isArray(manifest[key]) && manifest[key].length === 0), `${key} must be empty`);
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(manifest.scripts?.[hook], undefined, `${hook} must not require development tools`);
  const tree = JSON.parse(run('npm', ['ls', '--all', '--omit=dev', '--json'], temp));
  assert.deepEqual(Object.keys(tree.dependencies), ['koyuki']);
  assert.equal(Object.keys(tree.dependencies.koyuki.dependencies ?? {}).length, 0);
  const dist = join(installed, 'dist');
  const files = readdirSync(dist).filter(name => name.endsWith('.js'));
  const bundled = await build({ entryPoints: files.map(name => join(dist, name)), outdir: join(temp, 'bundle'), bundle: true, platform: 'browser', packages: 'external', format: 'esm', write: false, metafile: true });
  for (const output of Object.values(bundled.metafile.outputs)) assert.equal(output.imports.length, 0, 'runtime imports must resolve inside the package');
  for (const input of Object.keys(bundled.metafile.inputs)) assert(!relative(realpathSync(dist), realpathSync(resolve(input))).startsWith('..'), 'runtime import escapes package');
  writeFileSync(join(temp, 'consumer.ts'), `import { defineUseCase, step, ok } from 'koyuki';
const operation = defineUseCase({ operation: 'web', load: async (input: number) => ok(input),
  transition: { validate: step('validate', (n: number) => ok(n)), require: [] as const, evolve: step('double', (n: number) => ok(n * 2)) },
  save: async (value: number) => ok(value),
});
const result = await operation.run(2);
if (result.ok) { const n: number = result.value; console.log(n); }
`);
  writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: [], lib: ['ES2022', 'DOM'] }, include: ['consumer.ts', 'node_modules/koyuki/dist/**/*.d.ts'] }));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(temp, 'tsconfig.json')], temp);
  console.log(`Verified ${manifest.name}@${manifest.version}: no runtime dependencies, ${files.length} local-only JS modules and all public declarations, consumer types without @types/node.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
