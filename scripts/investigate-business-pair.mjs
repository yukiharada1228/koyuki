import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Investigate declarations in disposable source copies. Never patch the worktree.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && !['--binding', '--raw-definition', '--literal-connection', '--pair-first', '--unconstrained', '--literal-all', '--context-shapes', '--with-input-literal'].includes(args[0])) throw Error('Unknown investigation mode');
const inputLiteral = args[0] === '--with-input-literal';
const contextShapes = args[0] === '--context-shapes';
const literalAll = args[0] === '--literal-all';
const unconstrained = args[0] === '--unconstrained';
const pairFirst = args[0] === '--pair-first' || unconstrained;
const literalConnection = args[0] === '--literal-connection' || pairFirst || literalAll;
const binding = args[0] === '--binding' || literalConnection || contextShapes || inputLiteral;
const rawDefinition = args[0] === '--raw-definition';
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
const originalModel = await readFile(resolve(root, 'src/framework/model.ts'), 'utf8');
const fixture = await readFile(resolve(root, 'scripts/fixtures/business-input-pair.ts'), 'utf8');
const first = 'type StageOutput<F extends Stage, I> = [Out<F>] extends [I] ? Out<F>';
const last = '? I & Out<F> : Out<F>;';
if (original.split(first).length !== 2 || original.split(last).length !== 2) throw Error('Re-evaluate declaration patch');
const candidates = [['current', original]];
for (const [name, shape] of binding || rawDefinition ? [] : [
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
if (rawDefinition) {
  // Infer the entire declaration without contextualizing the tuple, then verify
  // its existing contracts. This is an investigation, not a public overload.
  const marker = 'export function business<L extends Load, O, S extends Execution<unknown>';
  const overload = `export function business<const D extends { name: string; load: Load; save: SaveFn; operations: Record<string, Entry>; replay?: never }>(definition: D & NoInfer<{
  operation?: (name: OperationNames<D['operations']>) => string;
  save: D['save'] extends (value: SaveInput<D['save']>, context: GroupExecution<OperationNames<D['operations']>, Requests<D['load'], D['operations']>>) => Promise<Result<unknown, unknown>> ? D['save'] : never;
  operations: { readonly [K in keyof D['operations']]: K extends string | number ? K extends 'then' ? never : Checked<D['load'], D['operations'][K], SaveInput<D['save']>, OperationName<K>> : never };
}>): Commands<D['load'], D['operations'], Value<SaveResult<D['save']>>, Failure<SaveResult<D['save']>>, never, D>;
`;
  if (original.split(marker).length !== 2) throw Error('Re-evaluate raw definition overload');
  const raw = original.replace(marker, overload + marker);
  const helper = "type InputPairCandidate<O, I> = { [K in keyof O]: K extends 'input' ? I : O[K] };\n"
    + 'type InputPairOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }]\n'
    + '  ? [RuleOf<F>] extends [(input: I) => Result<InputPairCandidate<Out<F>, I>, ErrorOf<F>>] ? InputPairCandidate<Out<F>, I> : Out<F>\n'
    + '  : Out<F>;\n';
  const pair = source => source.replace(first, helper + first).replace(last, '? I & Out<F> : InputPairOutput<F, I>;')
    .replace('[RuleOf<F>] extends [Rule<I, O, ErrorOf<F>>]', '[RuleOf<F>] extends [(input: I) => Result<O, ErrorOf<F>>]');
  candidates.push(['raw-definition', raw], ['raw-definition-and-literal-pair', pair(raw)]);
}
if (binding) {
  const helper = "type InputPairCandidate<O, I> = { [K in keyof O]: K extends 'input' ? I : O[K] };\n"
    + 'type PairRuleOutput<R extends (...args: never[]) => unknown, I> = R extends (input: I) => Result<InputPairCandidate<Value<ReturnType<R>>, I>, Failure<ReturnType<R>>> ? InputPairCandidate<Value<ReturnType<R>>, I> : Value<ReturnType<R>>;\n'
    + 'type InputPairOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }] ? PairRuleOutput<RuleOf<F>, I> : Out<F>;\n';
  const candidate = original.replace(first, helper + first).replace(last, '? I & Out<F> : InputPairOutput<F, I>;')
    .replace('[RuleOf<F>] extends [Rule<I, O, ErrorOf<F>>]', '[RuleOf<F>] extends [(input: I) => Result<O, ErrorOf<F>>]');
  if (candidate === original) throw Error('Binding candidate patch did not apply');
  candidates.push(['literal-call-contract', candidate]);
  if (inputLiteral) {
    const signature = 'export function withInput<I, O, E>(rule: Rule<I, O, E>): Rule<I, Readonly<{ input: I; value: O }>, E> {';
    if (originalModel.split(signature).length !== 2) throw Error('Re-evaluate withInput signature');
    for (const [name, parameter, result] of [
      ['literal-parameter', '(input: I) => Result<O, E>', 'Rule<I, Readonly<{ input: I; value: O }>, E>'],
      ['literal-return', 'Rule<I, O, E>', '(input: I) => Result<Readonly<{ input: I; value: O }>, E>'],
      ['literal-parameter-and-return', '(input: I) => Result<O, E>', '(input: I) => Result<Readonly<{ input: I; value: O }>, E>'],
    ]) candidates.push([name, candidate, originalModel.replace(signature, `export function withInput<I, O, E>(rule: ${parameter}): ${result} {`)]);
  }
  if (literalAll) {
    let expanded = candidate;
    for (const [before, after] of [
      ['type Fn = Rule<never, unknown, unknown>;', 'type Fn = (input: never) => Result<unknown, unknown>;'],
      ['[Rule<I, I, ErrorOf<F>>]', '[(input: I) => Result<I, ErrorOf<F>>]'],
      ['[Rule<I, I & Out<F>, ErrorOf<F>>]', '[(input: I) => Result<I & Out<F>, ErrorOf<F>>]'],
      ['[Rule<I, Out<F>, ErrorOf<F>>]', '[(input: I) => Result<Out<F>, ErrorOf<F>>]'],
      ['F extends Fn ? Rule<I, O, ErrorOf<F>>', 'F extends Fn ? ((input: I) => Result<O, ErrorOf<F>>)'],
      ['readonly run: Rule<I, O, ErrorOf<F>>', 'readonly run: (input: I) => Result<O, ErrorOf<F>>'],
    ]) {
      if (!expanded.includes(before)) throw Error(`Re-evaluate expanded call comparison: ${before}`);
      expanded = expanded.replaceAll(before, after);
    }
    candidates.push(['expanded-rule-comparisons', expanded]);
  }
  if (literalConnection) {
    const checked = "F extends Fn ? Rule<I, O, ErrorOf<F>>";
    if (candidate.split(checked).length !== 2) throw Error('Re-evaluate literal connection requirement');
    candidates.push(['literal-guard-and-connection', candidate.replace(checked, 'F extends Fn ? ((input: I) => Result<O, ErrorOf<F>>)')]);
    if (pairFirst) {
      // Earlier candidates placed pair specialization after generic identity/proof
      // checks. Test the actual pair contract before those conditional branches.
      const pair = `type StageOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }]
  ? [RuleOf<F>] extends [(input: I) => Result<InputPairCandidate<Out<F>, I>, ErrorOf<F>>]
    ? InputPairCandidate<Out<F>, I> : FallbackStageOutput<F, I>
  : FallbackStageOutput<F, I>;
`;
      const prioritized = candidate.replace('type StageOutput<F extends Stage, I> =', pair + 'type FallbackStageOutput<F extends Stage, I> =')
        .replace(checked, 'F extends Fn ? ((input: I) => Result<O, ErrorOf<F>>)');
      candidates.push(['pair-before-identity-and-proof', prioritized]);
      const connectionStart = 'type Connect<C, P extends readonly Stage[], O, Operation extends string> = {';
      if (prioritized.split(connectionStart).length !== 2) throw Error('Re-evaluate recursive connection candidate');
      const connection = `type Connect<C, P extends readonly Stage[], O, Operation extends string, A extends readonly unknown[] = readonly []> =
  number extends P['length'] ? MappedConnect<C, P, O, Operation>
  : P extends readonly [infer F extends Stage, ...infer R extends readonly Stage[]]
    ? Connect<StageOutput<F, C>, R, O, Operation, readonly [...A,
      DiagnosticRule<F, C, R extends readonly [] ? O : StageOutput<F, C>, Operation, \`\${A['length']}\`>]>
    : A;
`;
      candidates.push(['pair-first-recursive-connection', prioritized.replace(connectionStart,
        connection + 'type MappedConnect<C, P extends readonly Stage[], O, Operation extends string> = {')]);
      const raw = `type StudyRawCheck<D> = D extends { name: string; load: infer L extends Load; save: infer S extends SaveFn; operations: infer T extends Record<string, Entry>; replay?: never }
  ? { operation?: (name: OperationNames<T>) => string;
      save: S extends (value: SaveInput<S>, context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Promise<Result<unknown, unknown>> ? S : never;
      operations: { readonly [K in keyof T]: K extends string | number ? K extends 'then' ? never : Checked<L, T[K], SaveInput<S>, OperationName<K>> : never } }
  : never;
type StudyRawCommands<D extends object> = D extends { load: infer L extends Load; save: infer S extends SaveFn; operations: infer T extends Record<string, Entry> }
  ? Commands<L, T, Value<SaveResult<S>>, Failure<SaveResult<S>>, never, D> : never;
export function business<const D extends object>(definition: D & NoInfer<StudyRawCheck<D>>): StudyRawCommands<D>;
`;
      const marker = 'export function business<L extends Load, O, S extends Execution<unknown>';
      const literal = candidate.replace(checked, 'F extends Fn ? ((input: I) => Result<O, ErrorOf<F>>)');
      if (literal.split(marker).length !== 2) throw Error('Re-evaluate unconstrained definition candidate');
      candidates.push(['unconstrained-definition', literal.replace(marker, raw + marker)]);
    }
  }
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
  if (pairFirst) {
    const isolated = head + `
import type { PairStudyFirst, PairStudyLoaded, PairStudyRule, PairStudyOut, PairStudyStage } from './framework/business.js';
type Stages = readonly [typeof quoted, typeof finish];
type ExactFirstInput = Assert<Equal<PairStudyFirst<Stages>, Base>>;
type ExactLoaded = Assert<Equal<PairStudyLoaded<typeof load, Stages>, Context>>;
type ExactCallable = Assert<Equal<PairStudyRule<typeof quoted>, typeof quoted>>;
type ExactBroadOutput = Assert<Equal<PairStudyOut<typeof quoted>, Readonly<{ input: Base; value: number }>>>;
type ExactStageOutput = Assert<Equal<PairStudyStage<typeof quoted, Context>, Pair>>;
`;
    variants.push(['isolated-business-aliases', isolated]);
  }
}
if (unconstrained) candidates.splice(0, candidates.length, ...candidates.filter(([name]) => ['current', 'unconstrained-definition'].includes(name)));
if (literalAll) candidates.splice(0, candidates.length, ...candidates.filter(([name]) => ['current', 'expanded-rule-comparisons'].includes(name)));
if (contextShapes) {
  const context = /class Context \{[\s\S]*?\n\}/;
  const publicClass = `class Context {
  constructor(readonly amount: number, readonly currency: string) {}
  host() { return 'trusted'; }
}`;
  const record = `type Context = Readonly<{ amount: number; currency: string; host: () => string }>;
function makeContext(amount: number, currency: string): Context { return { amount, currency, host: () => 'trusted' }; }`;
  const originals = variants.splice(0);
  for (const [name, text] of originals) {
    if (!context.test(text) || !text.includes("new Context(input, 'JPY')")) throw Error('Re-evaluate context fixture');
    variants.push([`private-class/${name}`, text],
      [`public-class/${name}`, text.replace(context, publicClass)],
      [`record/${name}`, text.replace(context, record).replaceAll("new Context(input, 'JPY')", "makeContext(input, 'JPY')")]);
  }
}
const compiler = resolve(root, process.env.KOYUKI_STUDY_TSC ?? 'node_modules/.bin/tsc');
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
  for (const [candidate, source, model = originalModel] of candidates) {
    const aliases = pairFirst ? `
export type PairStudyFirst<P extends Pipeline> = FirstInput<P>;
export type PairStudyLoaded<L extends Load, P extends Pipeline> = Loaded<Loader<L, P>>;
export type PairStudyRule<F extends Stage> = RuleOf<F>;
export type PairStudyOut<F extends Stage> = Out<F>;
export type PairStudyStage<F extends Stage, I> = StageOutput<F, I>;
` : '';
    await writeFile(join(directory, 'src/framework/business.ts'), source + aliases);
    await writeFile(join(directory, 'src/framework/model.ts'), model);
    const baseline = compile();
    const probes = [];
    for (const [variant, text] of variants) {
      await writeFile(join(directory, 'src', probeName), text);
      const result = compile();
      const sites = result.diagnostics.filter(line => /error TS\d+/.test(line));
      const existingContractDiagnostics = sites.filter(line => !line.startsWith(`src/${probeName}(`)).length;
      if (existingContractDiagnostics || sites.some(line => /TS(2305|2307|7006):/.test(line))) throw Error(`Unexpected source/import/implicit-any diagnostic in ${candidate}/${variant}:\n${result.diagnostics.join('\n')}`);
      probes.push({ variant, fixtureSha256: hash(text), ...result, existingContractDiagnostics });
      await rm(join(directory, 'src', probeName));
    }
    reports.push({ candidate, businessSourceSha256: hash(source + aliases), modelSourceSha256: hash(model), baseline, probes });
  }
  if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain', '--', ...sourcePaths]) !== status
    || await readFile(resolve(root, 'src/framework/business.ts'), 'utf8') !== original
    || await readFile(resolve(root, 'src/framework/model.ts'), 'utf8') !== originalModel) throw Error('Investigation source changed during collection');
  process.stdout.write(JSON.stringify({
    schema: 'koyuki.business-pair-specialization.v1', study: inputLiteral ? 'with-input-signature' : contextShapes ? 'context-shapes' : literalAll ? 'expanded-rule-comparisons' : unconstrained ? 'unconstrained-definition' : pairFirst ? 'pair-before-identity-and-proof' : literalConnection ? 'literal-guard-and-connection' : rawDefinition ? 'raw-definition-inference' : binding ? 'binding-and-call-contracts' : 'output-specialization', collectedAt: new Date().toISOString(),
    sourceGitCommit: commit, sourceDirty: false,
    collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    compiler: version.stdout.trim(), compilerEntrypointSha256: hash(await readFile(compiler)), node: process.version,
    lockSha256: hash(await readFile(resolve(root, 'package-lock.json'))),
    scope: 'Static candidate investigation only. No candidate installed, no runtime or independent user evaluation, no claim that all possible improvements fail.',
    reports,
  }, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
