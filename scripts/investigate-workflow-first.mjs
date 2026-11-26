// Compare committed source archives with one explicit positive type probe.
// Never check out, reset or edit the user's working tree; no npm publication.
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.signal || result.status === null) throw result.error ?? Error(`Command terminated: ${result.signal}`);
  return result;
}
function git(args) { const result = command('git', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
const options = new Map(), args = process.argv.slice(2);
assert(args.length % 2 === 0, 'Use --before commit [--after commit] [--probe workflow|step]');
for (let i = 0; i < args.length; i += 2) {
  assert(['--before', '--after', '--probe'].includes(args[i]) && !options.has(args[i]), 'Unknown or repeated option');
  assert(args[i] === '--probe' ? ['workflow', 'step'].includes(args[i + 1]) : /^(?:HEAD|[0-9a-f]{7,40})$/.test(args[i + 1]), 'Use a supported probe or HEAD/hexadecimal commit ID'); options.set(args[i], args[i + 1]);
}
assert(options.has('--before'), '--before is required');
const before = git(['rev-parse', '--verify', `${options.get('--before')}^{commit}`]);
const after = git(['rev-parse', '--verify', `${options.get('--after') ?? 'HEAD'}^{commit}`]);
const probeKind = options.get('--probe') ?? 'workflow';
const collectorFiles = ['scripts/investigate-workflow-first.mjs', `scripts/fixtures/${probeKind}-generic-first.ts`];
assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', ...collectorFiles]), '', 'Commit collector and fixture before measuring');
const collectorCommit = git(['rev-parse', 'HEAD']);
const probe = await readFile(join(root, collectorFiles[1]), 'utf8');
const compiler = resolve(root, 'node_modules/.bin/tsc');
const version = command(compiler, ['--version']); assert.equal(version.status, 0);
const installedLock = hash(await readFile(join(root, 'package-lock.json')));
const temporary = await mkdtemp(join(tmpdir(), `koyuki-${probeKind}-first-`));
const reports = [];
function diagnostics(output) {
  return output.split('\n').filter(line => /error TS\d+:/.test(line)).map(line => {
    const location = line.match(/src[\\/]([^\n]+?)\((\d+),(\d+)\): error (TS\d+): (.*)/);
    assert(location, `Unexpected diagnostic outside src: ${line}`);
    return { file: `src/${location[1].replaceAll('\\', '/')}`, line: Number(location[2]), column: Number(location[3]), code: location[4], message: location[5] };
  });
}
try {
  for (const [label, commit] of [['before', before], ['after', after]]) {
    const workspace = join(temporary, label); await mkdir(workspace);
    const archive = command('git', ['archive', commit, 'src', 'tsconfig.json', 'package.json', 'package-lock.json'], { encoding: null });
    assert.equal(archive.status, 0, String(archive.stderr));
    const extracted = command('tar', ['-x', '-C', workspace], { input: archive.stdout }); assert.equal(extracted.status, 0, extracted.stderr);
    const lockHash = hash(await readFile(join(workspace, 'package-lock.json')));
    assert.equal(lockHash, installedLock, 'Both snapshots must use the current locked dependencies');
    await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
    const compile = () => {
      const result = command(compiler, ['--project', join(workspace, 'tsconfig.json'), '--pretty', 'false']);
      assert([0, 1, 2].includes(result.status), result.stderr);
      const found = diagnostics(result.stdout + result.stderr);
      assert(result.status === 0 || found.length > 0, 'Compiler failed without diagnostics');
      return { accepted: result.status === 0, diagnostics: found };
    };
    const baseline = compile(); assert(baseline.accepted, `Existing contracts fail for ${label}: ${JSON.stringify(baseline.diagnostics)}`);
    const file = `src/${probeKind}-first-investigation.ts`;
    assert.equal(git(['ls-tree', '--name-only', commit, '--', file]), '', 'Probe would overwrite a committed source');
    await writeFile(join(workspace, file), probe);
    const result = compile(), existing = result.diagnostics.filter(item => item.file !== file);
    assert.equal(existing.length, 0, JSON.stringify(existing));
    assert(!result.diagnostics.some(item => ['TS2305', 'TS2307', 'TS7006'].includes(item.code)), 'Missing exports/imports or implicit any are not evidence for this probe');
    reports.push({ label, sourceGitCommit: commit, sourceArchiveSha256: hash(archive.stdout), lockSha256: lockHash,
      workflowSourceSha256: hash(await readFile(join(workspace, 'src/framework/workflow.ts'))),
      ...(probeKind === 'step' ? { modelSourceSha256: hash(await readFile(join(workspace, 'src/framework/model.ts'))) } : {}), baselineAccepted: true,
      probeAccepted: result.accepted, existingContractDiagnostics: existing.length, diagnostics: result.diagnostics });
  }
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', ...collectorFiles]), '');
  assert.equal(git(['rev-parse', 'HEAD']), collectorCommit, 'Collector source changed while running');
  console.log(JSON.stringify({ schema: `koyuki.${probeKind}-first-inference.v1`, collectedAt: new Date().toISOString(), collectorGitCommit: collectorCommit,
    collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))), probeSha256: hash(probe), compiler: version.stdout.trim(),
    scope: 'Committed source archives and current identical locked dependencies. Static type checks only; not runtime behavior, audio review or independent user DX.', reports }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
