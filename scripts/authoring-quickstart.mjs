import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verify = args.length === 1 && args[0] === '--verify';
assert(verify || (args.length === 2 && args[0] === '--prepare'), 'Use --verify or --prepare /unused/path');
function run(command, args, cwd = root, fail = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert(!result.error && result.status !== null && (fail ? result.status !== 0 : result.status === 0), output || String(result.error));
  return output;
}
const temp = mkdtempSync(join(tmpdir(), 'koyuki-authoring-quickstart-'));
try {
  const consumer = verify ? join(temp, 'consumer') : resolve(args[1]);
  assert(!existsSync(consumer), 'Refusing to overwrite an existing directory');
  run('npm', ['run', 'build']);
  const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp]))[0];
  mkdirSync(consumer);
  copyFileSync(join(temp, pack.filename), join(consumer, 'koyuki-development.tgz'));
  writeFileSync(join(consumer, 'DEVELOPMENT.json'), JSON.stringify({ baseCommit: run('git', ['rev-parse', 'HEAD']).trim(), sha256: createHash('sha256').update(readFileSync(join(temp, pack.filename))).digest('hex'), scope: 'Unpublished tarball built from current working tree. Not the npm registry alpha.5.' }, null, 2));
  for (const file of ['domain.ts', 'app.tsx', 'main.ts', 'trace.ts', 'replay.tsx', 'verify.ts', 'tsconfig.json', 'README.md']) copyFileSync(join(root, 'examples/authoring-quickstart', file), join(consumer, file));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { check: 'tsc --noEmit', start: 'tsx main.ts', trace: 'tsx trace.ts', replay: 'tsx replay.tsx', verify: 'tsx verify.ts' }, dependencies: { koyuki: 'file:./koyuki-development.tgz' }, devDependencies: { typescript: '7.0.2', tsx: '4.23.15' } }, null, 2));
  if (!verify) { console.log(`Prepared ${consumer}. Run npm install, npm run check and npm start there. Unpublished development package only.`); }
  else {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    for (const name of ['react', '@types/react', '@types/node']) assert(!existsSync(join(consumer, 'node_modules', name)), `Unexpected ${name}`);
    for (const command of ['check', 'start', 'trace', 'replay', 'verify']) console.log(run('npm', ['run', command], consumer).trim());
    const domainFile = join(consumer, 'domain.ts'), source = readFileSync(domainFile, 'utf8');
    assert(run(process.execPath, [fileURLToPath(import.meta.url), '--prepare', consumer], root, true).includes('Refusing to overwrite'));
    assert.equal(readFileSync(domainFile, 'utf8'), source);
    writeFileSync(domainFile, source.replace('if (booking.owner !== actor)', 'if (false)'));
    run('npm', ['run', 'check'], consumer);
    assert(run('npm', ['run', 'verify'], consumer, true).includes('ForbiddenMustNotSave'));
    writeFileSync(domainFile, source);
    console.log('Missing authorization was rejected by the business test; existing directories were preserved.');
    const changed = source.replace("return booking.kind === 'booked'", "if (booking.id === 'locked') return err('CancellationLocked');\n    return booking.kind === 'booked'").replace("'Forbidden' | 'AlreadyCancelled'>", "'Forbidden' | 'AlreadyCancelled' | 'CancellationLocked'>");
    assert.notEqual(source, changed); writeFileSync(domainFile, changed);
    writeFileSync(join(consumer, 'changed.ts'), `import { cancellation, createBookingApp, memoryBookings } from './app.js';
const repository = memoryBookings([{ kind: 'booked', id: 'locked', owner: 'alice' }]);
const result = await createBookingApp(repository, 'alice').execute(cancellation, { id: 'locked' });
if (result.ok || result.error !== 'CancellationLocked' || repository.saves !== 0) throw new Error('ChangedRuleNotApplied');
console.log('Domain-only rule change and inferred failure passed.');`);
    run('npm', ['run', 'check'], consumer);
    console.log(run('npm', ['exec', '--', 'tsx', 'changed.ts'], consumer).trim());
    console.log('Installed Quick Start verified without React or Node types; app, Providers and executor stayed unchanged.');
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
