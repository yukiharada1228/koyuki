import { cp, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Pin the pre-change declaration; rerunning after adoption must not silently
// turn the improved declaration into its own baseline. Other src files are current.
const baselineBusinessCommit = 'cf8ccf20e6fde43544aa37bd6951accc92efe28d';
const saved = spawnSync('git', ['show', `${baselineBusinessCommit}:src/framework/business.ts`], { cwd: root, encoding: 'utf8' });
if (saved.error || saved.status !== 0) throw saved.error ?? Error(saved.stderr);
const original = saved.stdout;
const rule = 'Rule<Inputs<C, P>[K & keyof Inputs<C, P>], K extends keyof Tail<P> ? Out<P[K]> : O, ErrorOf<P[K]>>';
if (!original.includes(rule)) throw Error('Connection declaration changed: review this candidate');
const helper = `type DiagnosticRule<F extends Fn, I, O, Operation extends string, Index extends PropertyKey> =
  ([F] extends [Rule<I, O, ErrorOf<F>>] ? unknown : {
    readonly [K in \`Koyuki: \${Operation}[\${Extract<Index, string | number>}] \${[F] extends [Rule<I, Out<F>, ErrorOf<F>>] ? 'output must match save' : 'input must accept prior output'}\`]: never
  }) & Rule<I, O, ErrorOf<F>>;
`;
const candidate = original.replace('type Connect<C,', helper + 'type Connect<C,')
  .replace('type Connect<C, P extends readonly Fn[], O>', 'type Connect<C, P extends readonly Fn[], O, Operation extends string>')
  .replace(rule, 'DiagnosticRule<P[K], Inputs<C, P>[K & keyof Inputs<C, P>], K extends keyof Tail<P> ? Out<P[K]> : O, Operation, K>')
  .replace('type Checked<L extends Load, E extends Entry, O>', 'type Checked<L extends Load, E extends Entry, O, Operation extends string>')
  .replace('Connect<Loaded<L>, E, O>', 'Connect<Loaded<L>, E, O, Operation>')
  .replace('Connect<Loaded<A>, P, O>', 'Connect<Loaded<A>, P, O, Operation>')
  .replace('Checked<L, T[K], O>', 'Checked<L, T[K], O, Extract<K, string>>')
  .replace('Checked<L, T[K], SaveInput<A>>', 'Checked<L, T[K], SaveInput<A>, Extract<K, string>>');
if (candidate === original || candidate.includes(rule)) throw Error('Candidate patch did not apply');
const probe = `import { business, ok, type Result } from './framework/index.js';
type Raw = { kind: 'raw' }; type Valid = { kind: 'valid' }; type Authorized = { kind: 'authorized' }; type Approved = { kind: 'approved' };
const load = async (_id: string): Promise<Result<Raw, never>> => ok({kind:'raw'});
const validate = (_value: Raw): Result<Valid, 'Invalid'> => ok({kind:'valid'});
const authorize = (_value: Valid): Result<Authorized, 'Denied'> => ok({kind:'authorized'});
const approve = (_value: Authorized): Result<Approved, never> => ok({kind:'approved'});
const save = async (value: Approved) => ok(value);
business({name:'expense',load,save,operations:{
  wrongFirst: [authorize, approve],
  omittedPermission: [validate, approve],
  wrongSave: [validate, authorize],
}});
`;
const temporary = await mkdtemp(join(tmpdir(), 'koyuki-business-diagnostics-'));
try {
  await cp(join(root, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(join(root, 'tsconfig.json'), join(temporary, 'tsconfig.json'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const normalize = text => text.replaceAll(relative(root, temporary), '<temporary>').replaceAll(temporary, '<temporary>');
  const compile = () => {
    const result = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(temporary, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
    if (result.error || result.signal || result.status === null) throw result.error ?? Error('Compiler terminated');
    if (![0, 1, 2].includes(result.status)) throw Error(result.stderr || result.stdout || `Unexpected compiler exit ${result.status}`);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  await writeFile(join(temporary, 'src/framework/business.ts'), original);
  const baseline = compile(); if (baseline.status !== 0) throw Error(baseline.output);
  const results = [];
  for (const [name, source] of [['baseline', original], ['stage-location-marker', candidate]]) {
    await writeFile(join(temporary, 'src/framework/business.ts'), source);
    const contract = compile();
    await writeFile(join(temporary, 'src/business-diagnostic-probe.ts'), probe);
    const diagnostics = compile();
    await rm(join(temporary, 'src/business-diagnostic-probe.ts'));
    results.push({ name, existingContractsPass: contract.status === 0,
      contractDiagnostics: normalize(contract.output),
      invalidProbeRejected: diagnostics.status !== 0,
      diagnosticCharacters: normalize(diagnostics.output).length,
      operationMarkersVisible: ['wrongFirst', 'omittedPermission', 'wrongSave'].filter(operation => diagnostics.output.includes(`Koyuki: ${operation}[`)),
      diagnostics: normalize(diagnostics.output) });
  }
  const version = spawnSync(join(root, 'node_modules/.bin/tsc'), ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw Error('Compiler version unavailable');
  console.log(JSON.stringify({ compiler: version.stdout.trim(), baselineBusinessCommit,
    contractScope: 'Current src copy with only business.ts replaced; not an immutable whole-repository comparison.',
    sourceSha256: createHash('sha256').update(original).digest('hex'), results }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
