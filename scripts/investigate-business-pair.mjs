import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Investigate declarations in disposable source copies. Never patch the worktree.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== '--binding') throw Error('Use no arguments or --binding');
const binding = args[0] === '--binding';
const hash = value => createHash('sha256').update(value).digest('hex');
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot identify source state');
  return result.stdout.trim();
}
const sourcePaths = ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/fixtures/business-input-pair.ts'];
const commit = git(['rev-parse', 'HEAD']);
const status = git(['status', '--porcelain', '--', ...sourcePaths]);
if (status) throw Error('Commit investigation sources before collecting evidence');
const original = await readFile(resolve(root, 'src/framework/business.ts'), 'utf8');
const fixture = await readFile(resolve(root, 'scripts/fixtures/business-input-pair.ts'), 'utf8');
const first = 'type StageOutput<F extends Stage, I> = [Out<F>] extends [I] ? Out<F>';
const last = '? I & Out<F> : Out<F>;';
if (original.split(first).length !== 2 || original.split(last).length !== 2) throw Error('Re-evaluate declaration patch');
const candidates = [['current', original]];
for (const [name, shape] of binding ? [] : [
  ['mapped-input', "{ [K in keyof O]: K extends 'input' ? I : O[K] }"],
  ['literal-pair', 'Readonly<{ input: I; value: O extends { readonly value: infer V } ? V : never }>'],
  ['intersection-input', 'O & Readonly<{ input: I }>'],
]) {
  const helper = `type InputPairCandidate<O, I> = ${shape};\n`
    + 'type InputPairOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }]\n'
    + '  ? [RuleOf<F>] extends [Rule<I, InputPairCandidate<Out<F>, I>, ErrorOf<F>>] ? InputPairCandidate<Out<F>, I> : Out<F>\n'
    + '  : Out<F>;\n';
  candidates.push([name, original.replace(first, helper + first).replace(last, '? I & Out<F> : InputPairOutput<F, I>;')]);
}
const variants = [
  ['inline-operations', fixture],
  ['bound-operations', fixture.replace('const inferred = business({', 'const inferredOperations = { quote: [quoted, finish] } as const;\nconst inferred = business({')
    .replace('operations: { quote: [quoted, finish] },', 'operations: inferredOperations,')],
];
if (binding) {
  const helper = "type InputPairCandidate<O, I> = { [K in keyof O]: K extends 'input' ? I : O[K] };\n"
    + 'type PairRuleOutput<R extends (...args: never[]) => unknown, I> = R extends (input: I) => Result<InputPairCandidate<Value<ReturnType<R>>, I>, Failure<ReturnType<R>>> ? InputPairCandidate<Value<ReturnType<R>>, I> : Value<ReturnType<R>>;\n'
    + 'type InputPairOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }] ? PairRuleOutput<RuleOf<F>, I> : Out<F>;\n';
  const candidate = original.replace(first, helper + first).replace(last, '? I & Out<F> : InputPairOutput<F, I>;')
    .replace('[RuleOf<F>] extends [Rule<I, O, ErrorOf<F>>]', '[RuleOf<F>] extends [(input: I) => Result<O, ErrorOf<F>>]');
  if (candidate === original) throw Error('Binding candidate patch did not apply');
  candidates.push(['literal-call-contract', candidate]);
  const head = fixture.split('// Direct generic withInput calls')[0];
  const bound = head + `
const config = { name: 'bound', load, save, operations: { quote: [quoted, finish] as const } };
const inferred = business(config);
type BoundInput = Assert<Equal<Parameters<typeof inferred.quote>[0], number>>;
type BoundOutput = Assert<Equal<Awaited<ReturnType<typeof inferred.quote>>, Result<string, 'Declined'>>>;
`;
  const prelude = head.replace('type Result }', 'type Result, type Rule }') + `
type PairValue<R> = R extends { ok: true; value: infer V } ? V : never;
type PairFailure<R> = R extends { ok: false; error: infer E } ? E : never;
type PairOut<F extends (...args: never[]) => unknown> = PairValue<ReturnType<F>>;
type PairCandidate<O, I> = { [K in keyof O]: K extends 'input' ? I : O[K] };
`;
  const literal = prelude + `
type Refined<F extends (...args: never[]) => unknown, I> = F extends (input: I) => Result<PairCandidate<PairOut<F>, I>, PairFailure<ReturnType<F>>> ? PairCandidate<PairOut<F>, I> : PairOut<F>;
type Exact = Assert<Equal<Refined<typeof quoted, Context>, Pair>>;
`;
  const aliased = literal.replace('F extends (input: I) => Result<PairCandidate<PairOut<F>, I>, PairFailure<ReturnType<F>>>', 'F extends Rule<I, PairCandidate<PairOut<F>, I>, PairFailure<ReturnType<F>>>');
  variants.splice(0, variants.length, ['inline-operations', fixture], ['bound-config', bound], ['isolated-literal-call', literal], ['isolated-rule-alias', aliased]);
}
const compiler = resolve(root, 'node_modules/.bin/tsc');
const version = spawnSync(compiler, ['--version'], { cwd: root, encoding: 'utf8' });
if (version.status !== 0) throw Error('Compiler unavailable');
const directory = await mkdtemp(join(tmpdir(), 'koyuki-business-pair-'));
const probeName = 'business-pair-investigation.ts';
const reports = [];
function compile() {
  const result = spawnSync(compiler, ['--noEmit'], { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw Error('Compiler did not complete');
  const output = result.stdout + result.stderr;
  const diagnostics = output.trim() ? output.trim().split('\n') : [];
  if (result.status !== 0 && !/error TS\d+/.test(output)) throw Error('Not a TypeScript diagnostic');
  return { accepted: result.status === 0, diagnostics };
}
try {
  await cp(resolve(root, 'src'), join(directory, 'src'), { recursive: true });
  for (const name of ['tsconfig.json', 'package.json']) await cp(resolve(root, name), join(directory, name));
  await symlink(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  try { await readFile(join(directory, 'src', probeName)); throw Error('Probe would overwrite source'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [candidate, source] of candidates) {
    await writeFile(join(directory, 'src/framework/business.ts'), source);
    const baseline = compile();
    const probes = [];
    for (const [variant, text] of variants) {
      await writeFile(join(directory, 'src', probeName), text);
      const result = compile();
      const sites = result.diagnostics.filter(line => /error TS\d+/.test(line));
      const existingContractDiagnostics = sites.filter(line => !line.startsWith(`src/${probeName}(`)).length;
      if (existingContractDiagnostics || sites.some(line => /TS(2305|2307|7006):/.test(line))) throw Error('Unexpected source/import/implicit-any diagnostic');
      probes.push({ variant, fixtureSha256: hash(text), ...result, existingContractDiagnostics });
      await rm(join(directory, 'src', probeName));
    }
    reports.push({ candidate, businessSourceSha256: hash(source), baseline, probes });
  }
  if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain', '--', ...sourcePaths]) !== status
    || await readFile(resolve(root, 'src/framework/business.ts'), 'utf8') !== original) throw Error('Investigation source changed during collection');
  process.stdout.write(JSON.stringify({
    schema: 'koyuki.business-pair-specialization.v1', study: binding ? 'binding-and-call-contracts' : 'output-specialization', collectedAt: new Date().toISOString(),
    sourceGitCommit: commit, sourceDirty: false,
    collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    compiler: version.stdout.trim(), node: process.version,
    lockSha256: hash(await readFile(resolve(root, 'package-lock.json'))),
    scope: 'Static candidate investigation only. No candidate installed, no runtime or independent user evaluation, no claim that all possible improvements fail.',
    reports,
  }, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
