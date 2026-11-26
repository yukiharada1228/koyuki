// Research only: apply the rejected type candidate in a temporary copy.
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const strictSignature = args.includes('--strict-signature');
if (strictSignature) args.splice(args.indexOf('--strict-signature'), 1);
if (args.length && (args.length !== 2 || args[0] !== '--compiler')) throw Error('Usage: node scripts/investigate-deep-step.mjs [--compiler /path/to/tsc] [--strict-signature]');
const compiler = resolve(args[1] ?? join(root, 'node_modules/.bin/tsc'));
const hash = value => createHash('sha256').update(value).digest('hex');
function command(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.error || result.signal) throw result.error ?? Error('Process interrupted');
  return result;
}
function git(args) {
  const result = command('git', args);
  if (result.status) throw Error(result.stderr);
  return result.stdout.trim();
}
const fixture = join(root, 'scripts/fixtures/deep-step-research');
const patch = await readFile(join(fixture, 'candidate.patch'), 'utf8');
const contracts = await readFile(join(fixture, 'contracts.txt'), 'utf8');
const signature = 'function overloaded<T>(input: T): Result<Readonly<{ input: T; value: Readonly<{ layer: Readonly<{ payload: T }> }> }>, never>;';
if (contracts.split(signature).length !== 2) throw Error('Overload fixture changed');
const counterexample = contracts.replace(signature, signature + '\n' + signature);
const temporary = await mkdtemp(join(tmpdir(), 'koyuki-deep-step-refusal-'));
const sourcePaths = ['src', 'tsconfig.json', 'package.json', 'package-lock.json'];
const version = command(compiler, ['--version']);
if (version.status) throw Error('Cannot identify compiler');
const provenance = {
  sourceGitCommit: git(['rev-parse', 'HEAD']),
  sourceDirty: Boolean(git(['status', '--porcelain', '--', ...sourcePaths])),
  compiler: version.stdout.trim(),
  collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  patchSha256: hash(patch), contractsSha256: hash(contracts), counterexampleSha256: hash(counterexample),
};
try {
  await cp(join(root, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(join(root, 'tsconfig.json'), join(temporary, 'tsconfig.json'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  function compile() {
    const result = command(compiler, ['--project', join(temporary, 'tsconfig.json'), '--pretty', 'false'], temporary);
    if (![0, 1, 2].includes(result.status)) throw Error('Compiler failed');
    const diagnostics = (result.stdout + result.stderr).split('\n').filter(line => /error TS\d+:/.test(line));
    if (result.status && !diagnostics.length) throw Error('Compiler failed without diagnostics');
    return diagnostics.map(line => line.replace(/^.*?(?=src\/)/, ''));
  }
  const baseline = compile();
  if (baseline.length) throw Error('Baseline contracts must pass');
  const apply = command('git', ['apply', join(fixture, 'candidate.patch')], temporary);
  if (apply.status) throw Error('Candidate no longer applies: ' + apply.stderr);
  if (strictSignature) {
    const modelPath = join(temporary, 'src/framework/model.ts');
    const model = await readFile(modelPath, 'utf8');
    const reverse = 'Reverse = [<T>(input: T) => Result<NestedPairShape<R, O, V, P, T, E>, E>] extends [R] ? true : false';
    assert.equal(model.split(reverse).length, 2, 'Research guard changed; re-inspect the candidate');
    await writeFile(modelPath, model.replace(reverse,
      'Reverse = NestedSame<R, <T>(input: T) => Result<NestedPairShape<R, O, V, P, T, E>, E>>'));
  }
  const target = join(temporary, 'src/transition-deep-values.test.ts');
  await writeFile(target, contracts);
  const candidateDiagnostics = compile();
  if (!strictSignature && candidateDiagnostics.length) throw Error('Candidate no longer passes its initial contracts: ' + candidateDiagnostics.join('\n'));
  await writeFile(target, counterexample);
  const counterexampleDiagnostics = compile();
  if (strictSignature) {
    // This guard must reject the known unsafe overload without discarding the
    // ordinary generic producers that motivated the original improvement.
    const expected = [
      'src/generic-object-correlation.test.ts(14,23): error TS2344:',
      'src/transition-deep-values.test.ts(16,23): error TS2344:',
      'src/transition-deep-values.test.ts(31,23): error TS2344:',
      'src/transition-deep-values.test.ts(43,23): error TS2344:',
      'src/transition-deep-values.test.ts(85,168): error TS2769:',
      'src/transition-deep-values.test.ts(89,23): error TS2344:',
    ];
    assert.equal(candidateDiagnostics.length, expected.length, 'Candidate precision changed; re-evaluate the strict-signature proposal');
    for (const prefix of expected) assert(candidateDiagnostics.some(line => line.startsWith(prefix)), candidateDiagnostics.join('\n'));
    assert.deepEqual(counterexampleDiagnostics, candidateDiagnostics,
      'Duplicating the overload must add no unsafe refinement; compare the actual diagnostics');
    console.log(JSON.stringify({ ...provenance, decision: 'rejected',
      proposal: 'Replace the reverse assignability check with exact equality to the constructed generic signature.',
      baselineDiagnostics: baseline.length, validProducerDiagnostics: candidateDiagnostics,
      counterexample: { additionalDuplicateGenericSignature: true, unsafeRefinementDetected: false,
        diagnostics: counterexampleDiagnostics },
      reason: 'The guard rejects the overload but also loses valid deep producer precision and a valid business connection.',
      limitations: ['This comparison does not establish a universal overload detector or TypeScript soundness.',
        'The product core, runtime, compiler installation and package are unchanged.'],
    }, null, 2));
  } else {
  // Use the last contract (the overloaded producer), not an unrelated failure.
  const lines = counterexample.split('\n');
  const overloadStart = lines.findIndex(line => line.startsWith("test('an earlier specialized overload"));
  const shapeLine = lines.findIndex((line, index) => index > overloadStart && line.includes('type Exact = Assert<Equal<typeof result.value, unknown>>;')) + 1;
  const refusalLine = lines.findIndex((line, index) => index > overloadStart && line.includes('@ts-expect-error')) + 1;
  const expected = [`src/transition-deep-values.test.ts(${shapeLine},23): error TS2344:`, `src/transition-deep-values.test.ts(${refusalLine},5): error TS2578:`];
  if (counterexampleDiagnostics.length !== 2 || !expected.every(prefix => counterexampleDiagnostics.some(line => line.startsWith(prefix)))) {
    throw Error('Counterexample changed; re-evaluate rather than assuming safety: ' + counterexampleDiagnostics.join('\n'));
  }
  console.log(JSON.stringify({ ...provenance, decision: 'rejected', baselineDiagnostics: baseline.length,
    initialContractDiagnostics: candidateDiagnostics.length,
    counterexample: { additionalDuplicateGenericSignature: true, unsafeRefinementDetected: true, diagnostics: counterexampleDiagnostics },
    limitations: ['A reflected two-signature comparison is not an exhaustive overload check.',
      'The specialized overload and generic signature disagree; this is not a proof of general TypeScript soundness or impossibility.',
      'No runtime source, compiler installation, or package was modified.'],
  }, null, 2));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
