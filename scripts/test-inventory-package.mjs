import { mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(args, cwd = root, capture = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `npm ${args.join(' ')} failed`);
  return result.stdout;
}
run(['run', 'build']);
const packed = JSON.parse(run(['pack', '--ignore-scripts', '--json'], root, true))[0];
const dir = mkdtempSync(join(tmpdir(), 'koyuki-package-inventory-'));
try {
  const example = join(root, 'examples/inventory');
  for (const file of readdirSync(example).filter(file => file.endsWith('.ts') || file === 'tsconfig.json')) copyFileSync(join(example, file), join(dir, file));
  const pkg = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
  pkg.dependencies.koyuki = `file:${join(root, packed.filename)}`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  run(['run', 'check'], dir);
  run(['test'], dir);
  run(['start'], dir);
  console.log(`Verified ${packed.id} from a packed install outside the source checkout.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
