// Prepare an unsolved participant workspace, or verify the exercise with a packed development package.
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['README.md', 'reference.md', 'feedback.md', 'package.json', 'tsconfig.json', 'contracts.ts', 'host.ts', 'application.ts', 'application.test.ts'];
const args = process.argv.slice(2);
const verify = args.length === 1 && args[0] === '--verify';
const prepare = args.length === 2 && args[0] === '--prepare';
assert(verify || prepare, 'Use --verify or --prepare /path/to/new-workspace');
const temporary = mkdtempSync(join(tmpdir(), 'koyuki-onboarding-'));
function npm(cwd, args, failure = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status === null || (failure ? result.status === 0 : result.status !== 0)) throw new Error(output || String(result.error));
  return output;
}
try {
  const workspace = verify ? join(temporary, 'workspace') : resolve(args[1]);
  assert(!existsSync(workspace), 'Refusing to overwrite an existing workspace');
  npm(root, ['run', 'build']);
  const packed = JSON.parse(npm(root, ['pack', '--ignore-scripts', '--pack-destination', temporary, '--json']))[0].filename;
  mkdirSync(workspace);
  for (const file of files) copyFileSync(join(root, 'examples/onboarding', file), join(workspace, file));
  copyFileSync(join(temporary, packed), join(workspace, 'koyuki-development.tgz'));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src/framework'], { cwd: root, encoding: 'utf8' });
  assert.equal(revision.status, 0); assert.equal(dirty.status, 0);
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const metadata = {
    baseCommit: revision.stdout.trim(), frameworkWorkingTreeChanged: dirty.stdout.trim().length > 0,
    packageVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    packageSha256: digest(join(workspace, 'koyuki-development.tgz')),
    exerciseFiles: Object.fromEntries([...files].sort().map(file => [file, digest(join(workspace, file))])),
    scope: 'Built from the working tree; the base commit is context, not proof that the package equals that commit.',
  };
  writeFileSync(join(workspace, 'DEVELOPMENT.json'), JSON.stringify(metadata, null, 2) + '\n');
  if (prepare) {
    console.log(`Prepared unsolved exercise with packed development package: ${workspace}\nRun npm install, npm run check, npm test in that directory. No npm publication or feedback collection.`);
  } else {
    assert.equal(readFileSync(join(workspace, 'application.ts'), 'utf8'), readFileSync(join(root, 'examples/onboarding/application.ts'), 'utf8'));
    const refused = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--prepare', workspace], { encoding: 'utf8' });
    assert(refused.status !== 0 && `${refused.stdout}${refused.stderr}`.includes('Refusing to overwrite an existing workspace'));
    for (const [file, expected] of Object.entries(metadata.exerciseFiles)) assert.equal(digest(join(workspace, file)), expected, 'Refused preparation must leave exercise data intact');
    assert.equal(digest(join(workspace, 'koyuki-development.tgz')), metadata.packageSha256);
    npm(workspace, ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
    npm(workspace, ['run', 'check']);
    const unsolved = npm(workspace, ['test'], true);
    assert(unsolved.includes('Implement createExpenses using business'), 'Starter must fail for the intended unsolved task');
    const reference = readFileSync(join(root, 'scripts/fixtures/onboarding-solution.ts'), 'utf8');
    const application = join(workspace, 'application.ts');
    writeFileSync(application, reference); npm(workspace, ['run', 'check']);
    console.log(npm(workspace, ['test']).trim());
    const authorization = "actor.role !== 'manager' || actor.id !== current.approverId || actor.id === current.ownerId";
    assert.equal(reference.split(authorization).length - 1, 2);
    writeFileSync(application, reference.replaceAll(authorization, 'false'));
    npm(workspace, ['run', 'check']); npm(workspace, ['test'], true);
    const version = "return input.expectedVersion === current.version ? null : { kind: 'Conflict' };";
    assert(reference.includes(version)); writeFileSync(application, reference.replace(version, 'return null;'));
    npm(workspace, ['run', 'check']); npm(workspace, ['test'], true);
    assert(reference.includes('submit: [submit]')); writeFileSync(application, reference.replace('submit: [submit]', 'submit: [approve]'));
    const diagnostic = npm(workspace, ['run', 'check'], true);
    assert(diagnostic.includes('application.test.ts'), 'Wrong output state must fail the public type contract');
    // The exercise permits domain rules to be split across multiple stages.
    // Preserve the AI review implementation as a second structural case.
    const staged = readFileSync(join(root, 'scripts/fixtures/onboarding-staged-solution.ts'), 'utf8');
    writeFileSync(application, staged); npm(workspace, ['run', 'check']);
    console.log(npm(workspace, ['test']).trim());
    const commonLoadOnly = staged
      .replace('submit: { load: ports.load<SubmitInput>, run: [common, submission, submit] },', 'submit: [common, submission, submit],')
      .replace('reject: { load: ports.load<RejectInput>, run: [common, approval, rejection, reject] },', 'reject: [common, approval, rejection, reject],');
    assert.notEqual(commonLoadOnly, staged);
    writeFileSync(application, commonLoadOnly); npm(workspace, ['run', 'check']);
    console.log(npm(workspace, ['test']).trim());
    const identity = 'function common<T extends Loaded<VersionInput>>(context: T): Result<T, RuleError>';
    assert(commonLoadOnly.includes(identity));
    writeFileSync(application, commonLoadOnly.replace(identity,
      'function common(context: Loaded<VersionInput>): Result<Loaded<VersionInput>, RuleError>'));
    const inferredInputFailure = npm(workspace, ['run', 'check'], true);
    assert(inferredInputFailure.includes('Koyuki: submit[1] input must accept prior output'));
    assert(inferredInputFailure.includes('Koyuki: reject[2] input must accept prior output'));
    assert(staged.includes('if (!context.actor.active)'));
    writeFileSync(application, staged.replace('if (!context.actor.active)', 'if (false)'));
    npm(workspace, ['run', 'check']); npm(workspace, ['test'], true);
    writeFileSync(application, staged);
    const prepared = join(temporary, 'participant');
    const preparation = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--prepare', prepared], { encoding: 'utf8' });
    assert.equal(preparation.status, 0, `${preparation.stdout}${preparation.stderr}`);
    for (const [file, expected] of Object.entries(metadata.exerciseFiles)) assert.equal(digest(join(prepared, file)), expected);
    const preparedMetadata = JSON.parse(readFileSync(join(prepared, 'DEVELOPMENT.json'), 'utf8'));
    assert.equal(digest(join(prepared, 'koyuki-development.tgz')), preparedMetadata.packageSha256);
    assert(!existsSync(join(prepared, 'node_modules'))); assert(!existsSync(join(prepared, 'onboarding-solution.ts')));
    console.log('Verified unsolved starter, single-rule, explicit-load staged, and shared-load staged behavior, three rejected rule mutations, two rejected typed connections, and preparation/refusal paths from the actual packed package. This is exercise readiness, not independent-user DX evidence.');
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
