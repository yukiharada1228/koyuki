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
  for (const file of ['domain.ts', 'repository.ts', 'application.ts', 'secrets.ts', 'delivery.ts', 'lease-delivery.ts']) {
    const source = readFileSync(join(root, 'src/registration', file), 'utf8').replaceAll("'../framework/index.js'", "'koyuki'");
    writeFileSync(join(dir, 'registration', file), source);
  }
  writeFileSync(join(dir, 'registration.test.ts'), readFileSync(join(root, 'src/registration.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  writeFileSync(join(dir, 'registration-lease.test.ts'), readFileSync(join(root, 'src/registration-lease.test.ts'), 'utf8').replaceAll("'./framework/index.js'", "'koyuki'"));
  const version = name => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { koyuki: `file:${join(dir, tarball)}` },
    devDependencies: { tsx: version('tsx'), typescript: version('typescript'), '@types/node': version('@types/node') },
    scripts: { check: 'tsc --noEmit', test: 'tsx --test registration*.test.ts' },
  }));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, types: ['node'] }, include: ['*.ts', 'registration/*.ts'] }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  npm(['run', 'check'], dir); npm(['test'], dir);
  // Broaden only the pure producers' annotations, leaving runtime code intact.
  // The installed sample must detect the loss of exact transition variants.
  const domainPath = join(dir, 'registration/domain.ts');
  const domain = readFileSync(domainPath, 'utf8');
  let broad = domain;
  for (const name of ['StartChange', 'ConfirmationChange']) {
    const narrow = `Result<${name}, never>`;
    if (broad.split(narrow).length !== 2) throw Error(`Expected one ${name} return contract`);
    broad = broad.replace(narrow, 'Result<Change, never>');
  }
  try {
    writeFileSync(domainPath, broad);
    const rejected = spawnSync('npm', ['exec', '--', 'tsc', '--pretty', 'false', '--noEmit'], { cwd: dir, encoding: 'utf8' });
    const output = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`;
    const testLines = readFileSync(join(dir, 'registration.test.ts'), 'utf8').split('\n');
    const expected = testLines.flatMap((line, index) => /^type Exact(Start|Confirm) =/.test(line) ? [index + 1] : []);
    if (rejected.error || !rejected.status || expected.length !== 2 || expected.some(line => !output.includes(`registration.test.ts(${line},`))
      || /TS(2305|2307|7006):/.test(output)) throw Error(`Broad transition annotations were not rejected at the exact contracts:\n${output}`);
  } finally { writeFileSync(domainPath, domain); }
  console.log('Verified exact start/confirmation variants; broad-return negative control rejected without changing runtime behavior.');
  console.log('Verified atomic outbox, leased delivery, acknowledgement recovery and human confirmation from the packed public API, including separate OS processes.');
  console.log('Verified fenced renewal, delayed ticks, slow-send lease maintenance, cancellation and concurrent shutdown failures against real SQLite. External mail providers and resident scheduling remain unverified.');
} finally { rmSync(dir, { recursive: true, force: true }); }
