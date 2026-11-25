import { mkdtempSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function npm(args, cwd, capture = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.stderr || `npm ${args.join(' ')} failed`);
  return result.stdout;
}
const registry = process.argv.includes('--registry');
const declarations = process.argv.includes('--declarations');
if (registry && declarations) throw new Error('New transition declarations are not published; test the packed development package');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
let dependency = version;
if (!registry) {
  npm(['run', 'build'], root);
  const tarball = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], root, true))[0].filename;
  dependency = `file:${join(root, tarball)}`;
}
const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-http-consumer-'));
try {
  const source = join(root, 'examples/leave-http');
  for (const file of readdirSync(source).filter(file => file.endsWith('.ts') || ['package.json', 'tsconfig.json'].includes(file))) copyFileSync(join(source, file), join(dir, file));
  if (declarations) {
    copyFileSync(join(dir, 'application.ts'), join(dir, 'application-named.ts'));
    copyFileSync(join(root, 'scripts/fixtures/leave-functions-application.ts'), join(dir, 'application.ts'));
    copyFileSync(join(root, 'scripts/fixtures/leave-functions-parity.test.ts'), join(dir, 'functions-parity.test.ts'));
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.dependencies.koyuki = dependency;
  if (declarations) pkg.scripts.test = 'tsx --test *.test.ts';
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  npm(['install', '--prefer-online', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  npm(['run', 'check'], dir);
  npm(['test'], dir);
  if (declarations) {
    copyFileSync(join(root, 'scripts/fixtures/transition-diagnostics.ts'), join(dir, 'transition-diagnostics.ts'));
    const result = spawnSync('npm', ['exec', '--', 'tsc', '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
    const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error || !result.status) throw new Error('Expected rejection of invalid transition declarations');
    for (const line of [5, 6, 7, 8, 9, 11, 13, 14]) if (!diagnostics.includes(`transition-diagnostics.ts(${line},`)) throw new Error(diagnostics);
    if (diagnostics.includes('TS7006') || diagnostics.includes('TS2305')) throw new Error(diagnostics);
    console.log(diagnostics);
  }
  console.log(`Verified leave HTTP example outside the repository using ${declarations ? 'packed development package with transition declarations' : registry ? 'npm registry' : 'packed package'} koyuki@${version}.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
