import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compile candidate declarations in an isolated copy. Never edit the working tree.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot identify investigation source');
  return result.stdout.trim();
}
const sourcePaths = ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/investigate-transition-inference.mjs', 'scripts/fixtures/business-input-pair.ts', 'scripts/fixtures/workflow-input-pair.ts'];
const sourceGitCommit = git(['rev-parse', 'HEAD']);
const sourceStatus = git(['status', '--porcelain', '--', ...sourcePaths]);
const original = await readFile(resolve(root, 'src/framework/model.ts'), 'utf8');
const requirement = 'require?: T & ConnectedStages<StageOutput<NoInfer<A>>, T>;';
if (!original.includes(requirement)) throw new Error('Declaration changed: re-evaluate candidate patches');
const inlineProbe = `
import { defineTransition, withInput, transition, ok, err, type Result } from './framework/index.js';
const quote = (amount: number): Result<number, 'Declined'> => amount > 0 ? ok(amount * 2) : err('Declined');
const flow = transition(defineTransition({
  validate: (amount: number) => ok(amount),
  require: [withInput(quote)],
  evolve: pair => ok(pair.input + pair.value),
}));
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exactInput: Equal<Parameters<typeof flow.run>[0], number> = true;
const exactResult: Equal<ReturnType<typeof flow.run>, Result<number, 'Declined'>> = true;
void exactInput; void exactResult;
`;
const probes = {
  inline: inlineProbe,
  'business-input-pair': await readFile(resolve(root, 'scripts/fixtures/business-input-pair.ts'), 'utf8'),
  'readonly-tuple': inlineProbe.replace('require: [withInput(quote)],', 'require: [withInput(quote)] as const,'),
  'named-step': inlineProbe.replace('withInput, transition,', 'withInput, step, transition,')
    .replace('require: [withInput(quote)],', "require: [step('quote', withInput(quote))],"),
  'local-factory': inlineProbe.replace('require: [withInput(quote)],', 'require: [(() => withInput(quote))()],'),
  'generic-identity-named-step': inlineProbe.replace('withInput, transition,', 'withInput, step, transition,')
    .replace(/^const quote = .*$/m, "const quote = <T>(value: T): Result<T, 'Declined'> => ok(value);")
    .replace('require: [withInput(quote)],', "require: [step('quote', withInput(quote))],"),
};
probes['business-input-pair-explicit'] = probes['business-input-pair'].split('// Direct generic withInput calls')[0];
probes['business-input-pair-inline'] = probes['business-input-pair-explicit']
  .replace('[explicitQuote, finish]', '[withInput((value: Context) => quote(value)), finish]');
probes['business-input-pair-named-step'] = probes['business-input-pair-explicit']
  .replace('business, withInput,', 'business, step, withInput,')
  .replace('[explicitQuote, finish]', "[step('calculate-quote', withInput((value: Context) => quote(value))), finish]");
probes['workflow-input-pair-bound'] = await readFile(resolve(root, 'scripts/fixtures/workflow-input-pair.ts'), 'utf8');
probes['workflow-input-pair-inline'] = probes['workflow-input-pair-bound']
  .replace("then('quote', quoted)", "then('quote', withInput(quote))");
probes['workflow-input-pair-callback'] = probes['workflow-input-pair-bound']
  .replace("then('quote', quoted)", "then('quote', withInput(value => quote(value)))");
probes['workflow-input-pair-first'] = probes['workflow-input-pair-bound']
  .replace("workflow('currency', currency).then('quote', quoted)", "workflow('quote', quoted)");
// Test whether removing the contextual call signature from the raw tuple helps
// nested higher-order calls, without changing withInput's generic function shape.
function rawTupleCandidate(constraint, spread = false, checked = false) {
  let source = original.replace('const T extends readonly AnyStage[] = readonly []', `const T extends readonly ${constraint}[] = readonly []`);
  const helper = 'type StageTuple<T> = Extract<T, readonly AnyStage[]>;\n' + (checked
    ? 'type ValidStageTuple<C, T> = T extends readonly AnyStage[] ? T extends ConnectedStages<C, T> ? true : false : false;\n' : '');
  source = source.replace('export function defineTransition<', helper + 'export function defineTransition<');
  const check = checked ? '[ValidStageTuple<StageOutput<A>, T>] extends [true]'
    : '[T] extends [ConnectedStages<StageOutput<A>, StageTuple<T>>]';
  source = source.replace(requirement, `require?: ${spread ? 'readonly [...T]' : 'T'} & NoInfer<${check} ? unknown : never>;`);
  source = source.replaceAll('StageEnd<StageOutput<A>, T>', 'StageEnd<StageOutput<A>, StageTuple<T>>')
    .replaceAll('NamedStages<T>', 'NamedStages<StageTuple<T>>')
    .replace('const stages: readonly AnyStage[] = definition.require ?? [];', 'const stages = (definition.require ?? []) as readonly AnyStage[];');
  return source;
}
// A tuple-shaped raw constraint can change contextual array inference without
// adding a callable member to withInput's return type or erasing its correlation.
function tupleConstraintCandidate(constraint) {
  const source = rawTupleCandidate(constraint);
  const previous = `const T extends readonly ${constraint}[] = readonly []`;
  if (!source.includes(previous)) throw Error('Raw tuple constraint patch did not apply');
  return source.replace(previous, `const T extends readonly [${constraint}, ...${constraint}[]] | readonly [] = readonly []`);
}
// Separate omitted requirements from a supplied tuple, so a default empty tuple
// cannot win inference for a context-sensitive higher-order expression.
function explicitRequirementOverloads(raw = false) {
  const start = original.indexOf('export function defineTransition<');
  const body = original.indexOf('  // Adjacency is proved', start);
  const signature = original.slice(start, body).replace(/ \{\n$/, ';\n');
  let required = signature.replace('const T extends readonly AnyStage[] = readonly []', 'const T extends readonly AnyStage[]')
    .replace('require?: T &', 'require: T &');
  if (raw) {
    required = required.replace('const T extends readonly AnyStage[]', 'const T extends readonly object[]')
      .replace('require: T & ConnectedStages<StageOutput<NoInfer<A>>, T>;', 'require: T & NoInfer<T extends ConnectedStages<StageOutput<A>, Extract<T, readonly AnyStage[]>> ? unknown : never>;')
      .replaceAll('StageEnd<StageOutput<A>, T>', 'StageEnd<StageOutput<A>, Extract<T, readonly AnyStage[]>>')
      .replaceAll('NamedStages<T>', 'NamedStages<Extract<T, readonly AnyStage[]>>');
  }
  const absent = signature.replace('const T extends readonly AnyStage[] = readonly [], ', '')
    .replace('require?: T & ConnectedStages<StageOutput<NoInfer<A>>, T>;', 'require?: undefined;')
    .replaceAll('StageEnd<StageOutput<A>, T>', 'StageOutput<A>')
    .replaceAll('NamedStages<T>', 'readonly []');
  return original.slice(0, start) + required + absent + original.slice(start);
}
// Move only the adjacency diagnostic out of the contextually typed object.
// Valid calls still take one argument; invalid chains require an impossible rest.
function restConnectionCandidate(constraint) {
  let source = original.replace('const T extends readonly AnyStage[] = readonly []',
    constraint ? `const T extends readonly ${constraint}[] = readonly []` : 'const T = readonly []');
  source = source.replace(requirement, 'require?: T;');
  source = source.replace('export function defineTransition<', 'type RestStages<T> = Extract<T, readonly AnyStage[]>;\nexport function defineTransition<');
  source = source.replace('}): {\n  readonly validate: Step<StageInput<A>',
    '}, ...invalid: NoInfer<[T] extends [ConnectedStages<StageOutput<A>, RestStages<T>>] ? [] : [never]>): {\n  readonly validate: Step<StageInput<A>');
  source = source.replaceAll('StageEnd<StageOutput<A>, T>', 'StageEnd<StageOutput<A>, RestStages<T>>')
    .replaceAll('NamedStages<T>', 'NamedStages<RestStages<T>>')
    .replace('const stages: readonly AnyStage[] = definition.require ?? [];', 'const stages = (definition.require ?? []) as readonly AnyStage[];');
  return source;
}
const candidates = [
  ['current', original],
  ['input-preserving-generic-return', withInputReturn('<T extends I>(input: T) => Result<Readonly<{ input: T; value: O }>, E>')],
  ['whole-callable-no-infer-return', withInputReturn('NoInfer<Rule<I, Readonly<{ input: I; value: O }>, E>>')],
  ['tuple-rest-callable-return', withInputReturn('(...args: [I]) => Result<Readonly<{ input: I; value: O }>, E>')],
  ['deferred-with-input-return', deferredWithInputReturn()],
  ['raw-object-tuple-constraint', tupleConstraintCandidate('object')],
  ['raw-unknown-tuple-constraint', tupleConstraintCandidate('unknown')],
  ['stage-tuple-constraint', original.replace('const T extends readonly AnyStage[] = readonly []', 'const T extends readonly [AnyStage, ...AnyStage[]] | readonly [] = readonly []')],
  ['direct-requirement-output', directRequirementOutput()],
  ['indexed-stage-end', indexedStageEnd()],
  ['indexed-stage-end-mapped-connection', mappedAdjacency(true).replace('type StageEnd<I, T extends readonly AnyStage[]> = T extends readonly [infer H, ...infer R extends readonly AnyStage[]] ? StageEnd<StageOutput<H>, R> : I;', 'type StageEnd<I, T extends readonly AnyStage[]> = (readonly [I, ...{ readonly [K in keyof T]: StageOutput<T[K]> }])[T["length"]];')],
  ['with-input-return-no-infer', withInputReturn('Rule<NoInfer<I>, Readonly<{ input: NoInfer<I>; value: NoInfer<O> }>, NoInfer<E>>')],
  ['with-input-parameter-no-infer', withInputReturn('Rule<NoInfer<I>, Readonly<{ input: I; value: O }>, E>')],
  ['with-input-pair-no-infer', withInputReturn('Rule<I, Readonly<{ input: NoInfer<I>; value: NoInfer<O> }>, E>')],
  ['monomorphic-with-input-overload', monomorphicWithInput()],
  ['mapped-adjacency', mappedAdjacency(false)],
  ['mapped-adjacency-no-infer', mappedAdjacency(true)],
  ['raw-object-rest-check', restConnectionCandidate('object')],
  ['raw-unknown-rest-check', restConnectionCandidate('unknown')],
  ['unconstrained-rest-check', restConnectionCandidate()],
  ['required-tuple-overloads', explicitRequirementOverloads()],
  ['required-raw-overloads', explicitRequirementOverloads(true)],
  ['callable-empty-intersection', original.replace('Rule<I, Readonly<{ input: I; value: O }>, E> {', 'Rule<I, Readonly<{ input: I; value: O }>, E> & {} {')],
  ['callable-object-intersection', original.replace('Rule<I, Readonly<{ input: I; value: O }>, E> {', 'Rule<I, Readonly<{ input: I; value: O }>, E> & object {')],
  ['callable-empty-pick', original.replace('Rule<I, Readonly<{ input: I; value: O }>, E> {', 'Rule<I, Readonly<{ input: I; value: O }>, E> & Pick<Function, never> {')],
  ['callable-signature-object', original.replace('Rule<I, Readonly<{ input: I; value: O }>, E> {', '{ (input: I): Result<Readonly<{ input: I; value: O }>, E> } {')],
  ['raw-object-deferred-check', rawTupleCandidate('object')],
  ['raw-object-spread-check', rawTupleCandidate('object', true)],
  ['raw-unknown-deferred-check', rawTupleCandidate('unknown')],
  ['raw-object-per-branch-check', rawTupleCandidate('object', false, true)],
  ['non-inferred-connection', original.replace(requirement, 'require?: T & NoInfer<ConnectedStages<StageOutput<A>, T>>;')],
  ['spread-tuple', original.replace(requirement, 'require?: readonly [...T] & NoInfer<ConnectedStages<StageOutput<A>, T>>;')],
  // This accepts the inline probe, but must not sacrifice generic input/output correlation.
  ['callable-name-member', original.replace(
    'Rule<I, Readonly<{ input: I; value: O }>, E> {',
    'Rule<I, Readonly<{ input: I; value: O }>, E> & { readonly name: string } {')],
  ['no-empty-default', original.replace('const T extends readonly AnyStage[] = readonly []', 'const T extends readonly AnyStage[]')],
  ['deferred-connection', original.replace(requirement, 'require?: T;').replace(
    '}): {\n  readonly validate: Step<StageInput<A>',
    '} & NoInfer<T extends ConnectedStages<StageOutput<A>, T> ? unknown : never>): {\n  readonly validate: Step<StageInput<A>')],
];
function directRequirementOutput() {
  const signature = `export function defineTransition<const A extends object, R, RE, O, E>(definition: {
  validate: A & NoInfer<A extends AnyStage ? unknown : never>;
  require: readonly [Stage<StageOutput<NoInfer<A>>, R, RE>];
  evolve: Stage<NoInfer<R>, O, E>;
}): {
  readonly validate: Step<StageInput<A>, StageOutput<A>, StageFailure<A>>;
  readonly require: readonly [Step<StageOutput<A>, R, RE>];
  readonly evolve: Step<R, O, E>;
};
`;
  const start = original.indexOf('export function defineTransition<');
  const body = original.indexOf('  // Adjacency is proved', start);
  const fallback = original.slice(start, body).replace(/ \{\n$/, ';\n');
  return original.slice(0, start) + signature + fallback + original.slice(start);
}
function indexedStageEnd() {
  return original.replace('type StageEnd<I, T extends readonly AnyStage[]> = T extends readonly [infer H, ...infer R extends readonly AnyStage[]] ? StageEnd<StageOutput<H>, R> : I;', 'type StageEnd<I, T extends readonly AnyStage[]> = (readonly [I, ...{ readonly [K in keyof T]: StageOutput<T[K]> }])[T["length"]];');
}
function withInputReturn(type) {
  return original.replace('): Rule<I, Readonly<{ input: I; value: O }>, E> {', `): ${type} {`);
}
// A non-distributive conditional can defer the contextual return signature of
// the nested call. Check the full generic contracts before adopting it: a fixed
// monomorphic probe alone cannot establish higher-order correlation.
function deferredWithInputReturn() {
  const signature = 'export function withInput<I, O, E>(rule: Rule<I, O, E>): Rule<I, Readonly<{ input: I; value: O }>, E>';
  const deferred = '[I] extends [I] ? Rule<I, Readonly<{ input: I; value: O }>, E> : never';
  return original.replace(signature, `export function withInput<I, O, E>(rule: Rule<I, O, E>): ${deferred}`)
    .replace('  return input => {\n    const result = rule(input);', '  const carried: Rule<I, Readonly<{ input: I; value: O }>, E> = input => {\n    const result = rule(input);')
    .replace('value: result.value }) } : result;\n  };\n}', `value: result.value }) } : result;\n  };\n  return carried as ${deferred};\n}`);
}
function mappedAdjacency(noInfer) {
  const helper = `type PriorStages<I, T extends readonly AnyStage[]> = readonly [I, ...{ readonly [K in keyof T]: StageOutput<T[K]> }];
type MappedConnection<I, T extends readonly AnyStage[]> = { readonly [K in keyof T]: Stage<PriorStages<I, T>[K & keyof PriorStages<I, T>], StageOutput<T[K]>, StageFailure<T[K]>> };
`;
  return original.replace('export function defineTransition<', helper + 'export function defineTransition<')
    .replace(requirement, `require?: T & ${noInfer ? 'NoInfer<MappedConnection<StageOutput<A>, T>>' : 'MappedConnection<StageOutput<NoInfer<A>>, T>'};`);
}
function monomorphicWithInput() {
  const signature = 'export function withInput<I, O, E>(rule: Rule<I, O, E>): Rule<I, Readonly<{ input: I; value: O }>, E>';
  const overload = `export function withInput<const F extends Rule<never, unknown, unknown>>(rule: F & (unknown extends Parameters<F>[0] ? never : unknown)): Rule<Parameters<F>[0], Readonly<{ input: Parameters<F>[0]; value: StageOutput<F> }>, StageFailure<F>> & object;
${signature};
`;
  return original.replace(signature, overload + signature);
}
const args = process.argv.slice(2);
let selected = candidates.map(([name]) => name), compiler = resolve(root, 'node_modules/.bin/tsc'), probeVariant = 'inline';
const options = new Set();
for (let index = 0; index < args.length; index += 2) {
  const option = args[index], value = args[index + 1];
  if (!['--only', '--compiler', '--probe'].includes(option) || !value || options.has(option)) throw new Error('Use --only comma,separated,candidate,names, --compiler /path/to/tsc, and/or --probe with a documented variant');
  options.add(option);
  if (option === '--only') selected = value.split(',');
  else if (option === '--compiler') compiler = resolve(value);
  else probeVariant = value;
}
if (!selected.length || selected.some(name => !candidates.some(([candidate]) => candidate === name))) throw new Error('Unknown candidate name');
if (!Object.hasOwn(probes, probeVariant)) throw new Error('Unknown probe variant');
const probe = probes[probeVariant];
const temporary = await mkdtemp(join(tmpdir(), 'koyuki-inference-'));
try {
  await cp(resolve(root, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(resolve(root, 'tsconfig.json'), join(temporary, 'tsconfig.json'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await symlink(resolve(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const compile = () => {
    const result = spawnSync(compiler, ['--project', join(temporary, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8', cwd: root });
    if (result.error || result.signal || result.status === null) throw result.error ?? new Error(`Compiler terminated: ${result.signal}`);
    if (result.status !== 0 && result.status !== 1 && result.status !== 2) throw new Error(result.stderr || result.stdout);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const baseline = compile();
  if (baseline.status !== 0) throw new Error(`Existing type checks failed:\n${baseline.output}`);
  await writeFile(join(temporary, 'src/inference-probe.ts'), probe);
  const results = [];
  for (const [name, source] of candidates.filter(([name]) => selected.includes(name))) {
    if (name !== 'current' && source === original) throw new Error(`Candidate patch did not apply: ${name}`);
    await writeFile(join(temporary, 'src/framework/model.ts'), source);
    const result = compile();
    const diagnostics = result.output.split('\n').filter(line => /error TS\d+:/.test(line));
    if (result.status !== 0 && diagnostics.length === 0) throw new Error(result.output || 'Compiler failed without diagnostics');
    const probeDiagnostics = diagnostics.filter(line => line.includes('inference-probe.ts('));
    const existing = diagnostics.filter(line => !line.includes('inference-probe.ts('));
    const sites = existing.map(line => {
      const location = line.match(/src[\\/]([^\n]+?)\((\d+),(\d+)\): error (TS\d+):/);
      return location ? { file: `src/${location[1].replaceAll('\\', '/')}`, line: Number(location[2]), code: location[4] }
        : { file: 'outside-src', code: line.match(/error (TS\d+):/)[1] };
    });
    results.push({ name, accepted: result.status === 0,
      inlineProbeAccepted: probeDiagnostics.length === 0,
      probeAccepted: probeDiagnostics.length === 0,
      probeDiagnosticSites: probeDiagnostics.map(line => {
        const location = line.match(/inference-probe\.ts\((\d+),(\d+)\): error (TS\d+):/);
        if (!location) throw Error('Cannot locate probe diagnostic');
        return { line: Number(location[1]), column: Number(location[2]), code: location[3] };
      }),
      probeDiagnosticCodes: [...new Set(probeDiagnostics.map(line => line.match(/error (TS\d+):/)[1]))],
      existingContractDiagnostics: existing.length, existingDiagnosticSites: sites });
  }
  const minimalSource = await readFile(resolve(root, 'scripts/fixtures/transition-inference-minimal.ts'), 'utf8');
  const minimalFile = join(temporary, 'minimal.ts'), minimalConfig = join(temporary, 'minimal-config.json');
  await writeFile(minimalConfig, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ['ES2022'] }, files: ['minimal.ts'] }));
  const minimalCompile = () => {
    const result = spawnSync(compiler, ['--project', minimalConfig, '--pretty', 'false'], { encoding: 'utf8', cwd: temporary });
    if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw result.error ?? Error('Minimal compiler invocation failed');
    return { accepted: result.status === 0, diagnostics: (result.stdout + result.stderr).split('\n').filter(line => /error TS\d+:/.test(line)).map(line => line.replace(/^.*?minimal\.ts\(/, 'minimal.ts(')) };
  };
  if (!minimalSource.includes('// Inline reproduction')) throw Error('Minimal fixture marker changed');
  await writeFile(minimalFile, minimalSource.split('// Inline reproduction')[0]);
  const minimalBaseline = minimalCompile();
  if (!minimalBaseline.accepted) throw Error(JSON.stringify(minimalBaseline));
  await writeFile(minimalFile, minimalSource);
  const minimal = { fixtureSha256: createHash('sha256').update(minimalSource).digest('hex'), baselineAccepted: true, ...minimalCompile() };
  if (git(['rev-parse', 'HEAD']) !== sourceGitCommit || git(['status', '--porcelain', '--', ...sourcePaths]) !== sourceStatus || hash(await readFile(resolve(root, 'src/framework/model.ts'))) !== hash(original)) throw Error('Investigation source changed during execution');
  console.log(JSON.stringify({ collectedAt: new Date().toISOString(), sourceGitCommit, sourceDirty: sourceStatus.length > 0,
    collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))), probeSha256: hash(probe), probeVariant,
    compiler: compileVersion(compiler), modelSourceSha256: hash(original), existingContractsPass: true, minimal, results }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
function compileVersion(compiler) {
  const result = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot identify compiler');
  return result.stdout.trim();
}
