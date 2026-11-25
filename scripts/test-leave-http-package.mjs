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
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.dependencies.koyuki = dependency;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  npm(['install', '--prefer-online', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  npm(['run', 'check'], dir);
  npm(['test'], dir);
  console.log(`Verified leave HTTP example outside the repository using ${registry ? 'npm registry' : 'packed package'} koyuki@${version}.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
