// Counterfactual compiler research only. Never used by builds or published code.
import { cp, mkdtemp, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { classifyInlineInference } from './inline-inference-observation.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--compiler') throw Error('Use --compiler /path/to/typescript6/bin/tsc; this script does not download or modify the installed compiler');
const compiler = await realpath(resolve(args[1]));
const compilerRoot = dirname(dirname(compiler));
const manifest = JSON.parse(await readFile(join(compilerRoot, 'package.json'), 'utf8'));
if (manifest.name !== 'typescript' || manifest.version !== '6.0.3') throw Error('This branch-level experiment requires the inspected TypeScript 6.0.3 JavaScript compiler');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot identify source');
  return result.stdout.trim();
};
const paths = ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/investigate-generic-call-skip.mjs', 'scripts/inline-inference-observation.mjs', 'scripts/fixtures/transition-inference-limit.ts', 'scripts/fixtures/transition-inference-minimal.ts'];
const sourceGitCommit = git(['rev-parse', 'HEAD']), sourceStatus = git(['status', '--porcelain', '--', ...paths]);
const model = await readFile(join(root, 'src/framework/model.ts'));
const source = await readFile(join(compilerRoot, 'lib/_tsc.js'), 'utf8');
const guard = 'if (checkMode & 8 /* SkipGenericFunctions */ && !node.typeArguments && callSignatures.some(isGenericFunctionReturningFunction)) {';
if (source.split(guard).length !== 2) throw Error('Compiler guard changed; re-inspect before running the experiment');
const modified = source.replace(guard, guard.replace('if (', 'if (false && '));
const fixture = (await readFile(join(root, 'scripts/fixtures/transition-inference-limit.ts'), 'utf8')).replace("from 'koyuki'", "from './framework/index.js'");
const minimal = await readFile(join(root, 'scripts/fixtures/transition-inference-minimal.ts'), 'utf8');
const directory = await mkdtemp(join(tmpdir(), 'koyuki-generic-skip-'));
try {
  const project = join(directory, 'project'), modifiedRoot = join(directory, 'counterfactual-typescript');
  await cp(compilerRoot, modifiedRoot, { recursive: true });
  await writeFile(join(modifiedRoot, 'lib/_tsc.js'), modified);
  await cp(join(root, 'src'), join(project, 'src'), { recursive: true });
  await cp(join(root, 'tsconfig.json'), join(project, 'tsconfig.json'));
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
  await writeFile(join(project, 'probe-config.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', types: [], lib: ['ES2022', 'DOM'] }, files: ['src/transition-inference-limit.ts'] }));
  await writeFile(join(project, 'minimal.ts'), minimal);
  await writeFile(join(project, 'minimal-config.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ['ES2022'] }, files: ['minimal.ts'] }));
  const compile = (compiler, config) => {
    const result = spawnSync(process.execPath, [compiler, '--project', join(project, config), '--pretty', 'false'], { cwd: project, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw result.error ?? Error('Compiler failed without a completed check');
    return result;
  };
  const diagnostics = result => `${result.stdout}${result.stderr}`.split('\n').filter(line => /error TS\d+:/.test(line)).map(line => line.replace(/^.*?(src[\\/].*?\(\d+,\d+\): error TS\d+:)/, '$1').replace(/^.*?minimal\.ts\(/, 'minimal.ts('));
  const records = [];
  for (const [name, executable, modifiedCompiler] of [['official-typescript-6.0.3', compiler, false], ['counterfactual-skip-disabled', join(modifiedRoot, 'bin/tsc'), true]]) {
    await rm(join(project, 'src/transition-inference-limit.ts'), { force: true });
    const existing = compile(executable, 'tsconfig.json');
    await writeFile(join(project, 'src/transition-inference-limit.ts'), fixture);
    const probe = compile(executable, 'probe-config.json');
    const observation = classifyInlineInference(fixture, probe);
    const minimalResult = compile(executable, 'minimal-config.json');
    // Even an improved compiler must reject a result whose precise type is wrong.
    const wrong = fixture.replace('const exactInlineResult: Equal<ReturnType<typeof inline.run>, Result<number,', 'const exactInlineResult: Equal<ReturnType<typeof inline.run>, Result<string,');
    if (wrong === fixture) throw Error('Precision mutation did not apply');
    await writeFile(join(project, 'src/transition-inference-limit.ts'), wrong);
    const precision = compile(executable, 'probe-config.json');
    let observerRejected = false;
    try { classifyInlineInference(wrong, precision); } catch { observerRejected = true; }
    records.push({ name, modifiedCompiler, compilerPackageVersion: manifest.version,
      compilerImplementationSha256: hash(modifiedCompiler ? modified : source),
      existingContractsPass: existing.status === 0, existingDiagnostics: diagnostics(existing),
      inline: observation, inlineDiagnostics: diagnostics(probe),
      minimalAccepted: minimalResult.status === 0, minimalDiagnostics: diagnostics(minimalResult),
      wrongResultControl: { compilerRejected: precision.status !== 0, observerRejected, diagnostics: diagnostics(precision) } });
  }
  if (git(['rev-parse', 'HEAD']) !== sourceGitCommit || git(['status', '--porcelain', '--', ...paths]) !== sourceStatus || hash(await readFile(join(root, 'src/framework/model.ts'))) !== hash(model)) throw Error('Research source changed while collecting evidence');
  console.log(JSON.stringify({ schema: 'koyuki.generic-call-skip-control.v1', collectedAt: new Date().toISOString(), sourceGitCommit, sourceDirty: sourceStatus.length > 0,
    scope: 'One counterfactual branch in an isolated copy of the TypeScript 6.0.3 compiler. Not a supported compiler, framework fix, general soundness proof, source/audio review or independent-user trial. Installed compilers, Koyuki sources, dependencies and runtime are unchanged.',
    collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))), modelSha256: hash(model), fixtureSha256: hash(fixture), minimalSha256: hash(minimal),
    modifiedBranch: guard, replacement: guard.replace('if (', 'if (false && '), records }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
