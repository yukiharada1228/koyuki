import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'koyuki-registration-consumer-'));
try {
  npm(['run', 'build'], root);
  const tarball = JSON.parse(npm(['pack', '--pack-destination', dir, '--ignore-scripts', '--json'], root, true))[0].filename;
  mkdirSync(join(dir, 'registration'));
  for (const file of ['domain.ts', 'repository.ts', 'application.ts', 'delivery.ts']) {
    const source = readFileSync(join(root, 'src/registration', file), 'utf8').replaceAll("'../framework/index.js'", "'koyuki'");
    writeFileSync(join(dir, 'registration', file), source);
  }
  writeFileSync(join(dir, 'registration.test.ts'), readFileSync(join(root, 'src/registration.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  const version = name => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { koyuki: `file:${join(dir, tarball)}` },
    devDependencies: { tsx: version('tsx'), typescript: version('typescript'), '@types/node': version('@types/node') },
    scripts: { check: 'tsc --noEmit', test: 'tsx --test registration.test.ts' },
  }));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, types: ['node'] }, include: ['*.ts', 'registration/*.ts'] }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  npm(['run', 'check'], dir); npm(['test'], dir);
  console.log('Verified atomic outbox, leased delivery, acknowledgement recovery and human confirmation from the packed public API, including separate OS processes.');
} finally { rmSync(dir, { recursive: true, force: true }); }
