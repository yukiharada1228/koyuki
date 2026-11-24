import { mkdtempSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--development');
function npm(args, cwd, capture = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.stderr || `npm ${args.join(' ')} failed`);
  return result.stdout;
}
let tarball;
if (development) {
  npm(['run', 'build'], root);
  tarball = JSON.parse(npm(['pack', '--ignore-scripts', '--json'], root, true))[0].filename;
}
const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-consumer-'));
try {
  const source = join(root, 'examples/leave');
  for (const file of readdirSync(source).filter(file => file.endsWith('.ts') || ['package.json', 'package-lock.json', 'tsconfig.json'].includes(file))) copyFileSync(join(source, file), join(dir, file));
  if (development) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.dependencies.koyuki = `file:${join(root, tarball)}`;
    pkg.scripts.test = 'tsx --test *.test.ts';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    rmSync(join(dir, 'package-lock.json'));
    copyFileSync(join(root, 'scripts/fixtures/leave-replay-trace.test.ts'), join(dir, 'leave-replay-trace.test.ts'));
  }
  for (const args of [[development ? 'install' : 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'check'], ['test'], ['start']]) npm(args, dir);
  console.log(`Verified leave example outside the repository using ${development ? 'packed development package with replay detail' : 'published koyuki@0.1.0-alpha.2'}.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
