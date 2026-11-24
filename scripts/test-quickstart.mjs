import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function npm(args, cwd, expectedFailure = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || (expectedFailure ? result.status === 0 || result.status === null : result.status !== 0)) throw new Error(output || String(result.error));
  return output;
}
const registry = process.argv.includes('--registry');
const version = registry ? JSON.parse(readFileSync(join(root, 'examples/quickstart/package.json'), 'utf8')).dependencies.koyuki : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
let dependency = `koyuki@${version}`;
if (!registry) {
  npm(['run', 'build'], root);
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], root))[0];
  dependency = `file:${join(root, packed.filename)}`;
}
const dir = mkdtempSync(join(tmpdir(), 'koyuki-quickstart-'));
try {
  const example = join(root, 'examples/quickstart');
  for (const file of ['main.ts', 'tsconfig.json']) copyFileSync(join(example, file), join(dir, file));
  const pkg = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
  pkg.dependencies.koyuki = registry ? version : dependency;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  npm(['run', 'check'], dir);
  console.log(npm(['start'], dir).trim());
  mkdirSync(join(dir, 'diagnostics'));
  copyFileSync(join(example, 'diagnostics/invalid.ts'), join(dir, 'diagnostics/invalid.ts'));
  const config = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  config.include.push('diagnostics/*.ts');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  const diagnostics = npm(['exec', '--', 'tsc', '--pretty', 'false'], dir, true);
  for (const line of [5, 9, 12, 15]) {
    if (!diagnostics.includes(`diagnostics/invalid.ts(${line},`)) throw new Error(`Expected error at line ${line}:\n${diagnostics}`);
  }
  console.log(diagnostics.trim());
  console.log(`Verified quickstart and four rejected definitions from ${registry ? 'npm registry' : 'packed package'} (${version}).`);
} finally { rmSync(dir, { recursive: true, force: true }); }
