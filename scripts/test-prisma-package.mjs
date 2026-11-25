import { mkdtempSync, readdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function npm(args, cwd, capture = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.stderr || `npm ${args.join(' ')} failed`);
  return result.stdout;
}
const registry = process.argv.includes('--registry');
let dependency = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!registry) {
  npm(['run', 'build'], root);
  const tarball = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], root, true))[0].filename;
  dependency = `file:${join(root, tarball)}`;
}
const dir = mkdtempSync(join(tmpdir(), 'koyuki-prisma-consumer-'));
try {
  const source = join(root, 'examples/prisma-stock');
  for (const name of readdirSync(source).filter(name => name.endsWith('.ts') || ['package.json', 'tsconfig.json'].includes(name))) copyFileSync(join(source, name), join(dir, name));
  cpSync(join(source, 'prisma'), join(dir, 'prisma'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.dependencies.koyuki = dependency;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  // The native SQLite adapter needs its installation step; it is outside Koyuki.
  npm(['install', '--prefer-online', '--no-audit', '--no-fund'], dir);
  npm(['run', 'generate'], dir); npm(['run', 'check'], dir); npm(['test'], dir);
  console.log(`Verified Prisma 7.10.1 transaction context, typed rollback, two-record atomic writes and migration using ${registry ? 'npm registry' : 'packed development'} Koyuki outside the repository.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
