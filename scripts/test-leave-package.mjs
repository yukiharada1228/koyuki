import { mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-consumer-'));
try {
  const source = join(root, 'examples/leave');
  for (const file of readdirSync(source).filter(file => file.endsWith('.ts') || ['package.json', 'package-lock.json', 'tsconfig.json'].includes(file))) copyFileSync(join(source, file), join(dir, file));
  for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'check'], ['test'], ['start']]) {
    const result = spawnSync('npm', args, { cwd: dir, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
  }
  console.log('Verified leave example outside the repository using published koyuki@0.1.0-alpha.2.');
} finally { rmSync(dir, { recursive: true, force: true }); }
