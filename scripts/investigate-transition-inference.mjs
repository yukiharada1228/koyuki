import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compile candidate declarations in an isolated copy. Never edit the working tree.
const root = fileURLToPath(new URL('../', import.meta.url));
const original = await readFile(resolve(root, 'src/framework/model.ts'), 'utf8');
const requirement = 'require?: T & ConnectedStages<StageOutput<NoInfer<A>>, T>;';
if (!original.includes(requirement)) throw new Error('Declaration changed: re-evaluate candidate patches');
const probe = `
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
const candidates = [
  ['current', original],
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
const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 2 && args[0] === '--only'))) throw new Error('Use no arguments or --only comma,separated,candidate,names');
const selected = args.length ? args[1].split(',') : candidates.map(([name]) => name);
if (!selected.length || selected.some(name => !candidates.some(([candidate]) => candidate === name))) throw new Error('Unknown candidate name');
const temporary = await mkdtemp(join(tmpdir(), 'koyuki-inference-'));
try {
  await cp(resolve(root, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(resolve(root, 'tsconfig.json'), join(temporary, 'tsconfig.json'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await symlink(resolve(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const compiler = resolve(root, 'node_modules/.bin/tsc');
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
      probeDiagnosticCodes: [...new Set(probeDiagnostics.map(line => line.match(/error (TS\d+):/)[1]))],
      existingContractDiagnostics: existing.length, existingDiagnosticSites: sites });
  }
  console.log(JSON.stringify({ compiler: compileVersion(compiler), modelSourceSha256: createHash('sha256').update(original).digest('hex'), existingContractsPass: true, results }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
function compileVersion(compiler) {
  const result = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot identify compiler');
  return result.stdout.trim();
}
