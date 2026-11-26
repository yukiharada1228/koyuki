// Isolated type-inference research. Does not modify runtime or working-tree source.
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--compiler')) throw Error('Usage: node scripts/investigate-deep-output.mjs [--compiler /path/to/tsc]');
const compiler = resolve(args[1] ?? join(root, 'node_modules/.bin/tsc'));
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw Error('Cannot identify research source');
  return r.stdout.trim();
};
const paths = ['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/investigate-deep-output.mjs'];
const sourceGitCommit = git(['rev-parse', 'HEAD']), sourceStatus = git(['status', '--porcelain', '--', ...paths]);
const model = await readFile(join(root, 'src/framework/model.ts'), 'utf8');
const business = await readFile(join(root, 'src/framework/business.ts'), 'utf8');
const helper = `
type PathValues<M> = M[keyof M];
type OutputPaths<O, Seen = never> = unknown extends O ? readonly [] : O extends object
  ? O extends (...args: never[]) => unknown ? never : [O] extends [Seen] ? never
    : PathValues<{ [K in keyof O as K]-?: OutputPaths<O[K], Seen | O> extends infer P extends readonly PropertyKey[] ? readonly [K, ...P] : never }> : never;
type AtPath<O, P extends readonly PropertyKey[], T> = P extends readonly [infer H, ...infer Rest extends readonly PropertyKey[]]
  ? { [K in keyof O]: K extends H ? AtPath<O[K], Rest, T> : O[K] } : T & O;
type RelatedPaths<R, O, E, P = OutputPaths<O>> = P extends readonly PropertyKey[]
  ? [R] extends [<T>(input: T) => Result<AtPath<O, P, T>, E>] ? P : never : never;
type Under<P, K> = P extends readonly [K, ...infer Rest extends readonly PropertyKey[]] ? Rest : never;
type ApplyPaths<O, P, I> = [P] extends [never] ? O : [Extract<P, readonly []>] extends [never]
  ? { [K in keyof O]: ApplyPaths<O[K], Under<P, K>, I> } : I & O;
type DeepCandidate<R, I, O, E, Fallback, Paths = RelatedPaths<R, O, E>> = [Paths] extends [never] ? Fallback
  : [O] extends [object] ? [ApplyPaths<O, Paths, I>] extends [O]
    ? [R] extends [<T>(input: T) => Result<ApplyPaths<O, Paths, T>, E>]
      ? [R] extends [(input: I) => Result<ApplyPaths<O, Paths, I>, E>] ? ApplyPaths<O, Paths, I> : Fallback
      : Fallback : Fallback : Fallback;
export type DeepOutput<R, I, O, E, Fallback, P = R extends (input: infer A) => unknown ? A : never> =
  [O] extends [{ readonly input: I; readonly value: unknown }] ? Fallback
    : [unknown] extends [P] ? DeepCandidate<R, I, O, E, Fallback> : Fallback;
`;
const probe = `import { defineTransition, transition, step, withInput, ok, type Result } from './framework/index.js';
const wrap = <T>(input: T): Result<{ item: { value: T } }, 'Refused'> => ok({ item: { value: input } });
function forward<T>(input: T) {
  return transition(defineTransition({ validate: (value: T) => ok(value), require: [step('wrap', withInput(wrap))],
    evolve: pair => ok(pair.value.item.value) })).run(input);
}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const input = { id: 'request' }, result = forward(input);
const exact: Equal<typeof result, Result<typeof input, 'Refused'>> = true;
void exact;
`;
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Declaration layout changed; re-evaluate research patches');
  return source.replace(before, after);
}
const injected = replaceOnce(model, 'type PairOutput<F,', helper + 'type PairOutput<F,');
const globalModel = replaceOnce(replaceOnce(injected, 'type PairOutput<F,', 'type LegacyPairOutput<F,'), 'type StageEnd<I,',
  'type PairOutput<F, I, O = StageOutput<F>, E = StageFailure<F>> = DeepOutput<StageCall<F>, I, O, E, LegacyPairOutput<F, I, O, E>>;\ntype StageEnd<I,');
let globalBusiness = replaceOnce(business, 'Step, UniversalRuleOutput,', 'Step, DeepOutput, UniversalRuleOutput,');
globalBusiness = replaceOnce(globalBusiness, 'type StageOutput<F extends Stage, I> =', 'type LegacyStageOutput<F extends Stage, I> =');
globalBusiness = replaceOnce(globalBusiness, '// Tail recursion', 'type StageOutput<F extends Stage, I> = DeepOutput<RuleOf<F>, I, Out<F>, ErrorOf<F>, LegacyStageOutput<F, I>>;\n// Tail recursion');
let pairModel = replaceOnce(injected, '? PairShape<O, I, true> : Fallback', '? DeepCandidate<R, I, O, E, PairShape<O, I, true>> : Fallback');
pairModel = replaceOnce(pairModel, '? UniversalValuePair<R, I, O, E> : Fallback', '? DeepCandidate<R, I, O, E, UniversalValuePair<R, I, O, E>> : Fallback');
const candidates = [['current', model, business], ['unknown-leaf-paths-global', globalModel, globalBusiness], ['unknown-leaf-paths-universal-pair', pairModel, business]];
const temporary = await mkdtemp(join(tmpdir(), 'koyuki-deep-study-'));
try {
  await cp(join(root, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(join(root, 'tsconfig.json'), join(temporary, 'tsconfig.json'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  function compile() {
    const r = spawnSync(compiler, ['--project', join(temporary, 'tsconfig.json'), '--pretty', 'false'], { cwd: temporary, encoding: 'utf8' });
    if (r.error || r.signal || ![0, 1, 2].includes(r.status)) throw r.error ?? Error('Compiler failed');
    const diagnostics = (r.stdout + r.stderr).split('\n').filter(line => /error TS\d+:/.test(line));
    if (r.status !== 0 && !diagnostics.length) throw Error('Compiler failed without diagnostics');
    return diagnostics;
  }
  if (compile().length) throw Error('Existing source contracts must pass before research');
  await writeFile(join(temporary, 'src/deep-output-probe.ts'), probe);
  const results = [];
  for (const [name, modelCandidate, businessCandidate] of candidates) {
    await writeFile(join(temporary, 'src/framework/model.ts'), modelCandidate);
    await writeFile(join(temporary, 'src/framework/business.ts'), businessCandidate);
    const diagnostics = compile(), probeDiagnostics = diagnostics.filter(line => line.includes('deep-output-probe.ts('));
    const existing = diagnostics.filter(line => !line.includes('deep-output-probe.ts('));
    const sites = existing.map(line => {
      const match = line.match(/(?:^|\/)(src\/.*?)\((\d+),(\d+)\): error (TS\d+):/);
      if (!match) throw Error('Cannot locate research diagnostic');
      return { file: match[1], line: Number(match[2]), column: Number(match[3]), code: match[4] };
    });
    results.push({ name, modelSha256: hash(modelCandidate), businessSha256: hash(businessCandidate), probeAccepted: probeDiagnostics.length === 0,
      existingContractDiagnostics: existing.length, existingDiagnosticSites: sites, accepted: diagnostics.length === 0 });
  }
  const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw Error('Cannot identify compiler version');
  if (git(['rev-parse', 'HEAD']) !== sourceGitCommit || git(['status', '--porcelain', '--', ...paths]) !== sourceStatus) throw Error('Research source changed');
  console.log(JSON.stringify({ schema: 'koyuki.deep-output-investigation.v1', collectedAt: new Date().toISOString(), sourceGitCommit,
    sourceDirty: sourceStatus.length > 0, collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))), probeSha256: hash(probe),
    compiler: version.stdout.trim(), existingContractsPass: true, scope: 'Isolated static research, not adopted API or evidence of audio review or independent user trial.', results }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
