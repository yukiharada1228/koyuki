// Development-only generated consumer. No runtime dependency or npm publication.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
function command(program, args, cwd = root) {
  const start = performance.now();
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { ...result, elapsedMs: performance.now() - start };
}
function run(program, args, cwd) {
  const result = command(program, args, cwd);
  if (result.status !== 0) throw Error(result.stdout + result.stderr);
  return result;
}
const prelude = `import { business, ok, type Result } from 'koyuki';
declare const validated: unique symbol;
declare const authorized: unique symbol;
type Request<N extends string> = { operation: N; amount: number };
type Validated<N extends string> = Request<N> & { readonly [validated]: true };
type Authorized<N extends string> = Validated<N> & { readonly [authorized]: true };
type Approved<N extends string> = { operation: N; amount: number; status: 'approved' };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const load = <N extends string>() => async (input: Request<N>): Promise<Result<Request<N>, \`NotFound:\${N}\`>> => ok(input);
// Only these fixture proof constructors assert brands. The library must enforce adjacency.
const validate = <N extends string>() => (input: Request<N>): Result<Validated<N>, \`Invalid:\${N}\`> => ok(input as Validated<N>);
const permit = <N extends string>() => (input: Validated<N>): Result<Authorized<N>, \`Forbidden:\${N}\`> => ok(input as Authorized<N>);
const approve = <N extends string>() => (input: Authorized<N>): Result<Approved<N>, \`Closed:\${N}\`> => ok({ ...input, status: 'approved' });
const save = async <T extends Approved<string>>(value: T): Promise<Result<T, 'Conflict'>> => ok(value);
`;
function fixture(count, broken = false, segmented = true, plain = false) {
  const keys = Array.from({ length: count }, (_, index) => `op${index}`);
  const header = plain ? prelude.replace("import { business, ok, type Result } from 'koyuki';", "type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }; const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });") : prelude;
  const definition = plain ? 'const app = {\n' + keys.map(key => `${key}: async (input: Request<'${key}'>): Promise<Result<Approved<'${key}'>, 'NotFound:${key}' | 'Invalid:${key}' | 'Forbidden:${key}' | 'Closed:${key}' | 'Conflict'>> => ok({ ...input, status: 'approved' }),`).join('\n') + '\n};\n'
    : `const app = business({ name: 'scale', save, operations: {\n` + keys.map(key =>
      `${key}: { load: load<'${key}'>(), run: [validate<'${key}'>(), ${broken ? '' : `permit<'${key}'>(), `}approve<'${key}'>()] },`).join('\n') + '\n} });\n';
  return header + definition +
    (broken ? '' : keys.map((key, index) => `${segmented ? `function contract${index}() {` : ''}
type Input${index} = Assert<Equal<Parameters<typeof app.${key}>[0], Request<'${key}'>>>;
type Output${index} = Assert<Equal<Awaited<ReturnType<typeof app.${key}>>, Result<Approved<'${key}'>, 'NotFound:${key}' | 'Invalid:${key}' | 'Forbidden:${key}' | 'Closed:${key}' | 'Conflict'>>>;
if (false) {
  // @ts-expect-error input for another operation must not be accepted
  app.${key}({ operation: '${keys[(index + 1) % count]}', amount: 1 });
}${segmented ? '\n}' : ''}`).join('\n') + '\nlet completed = 0;\n' + keys.map(key => `${segmented ? `async function run${key}()` : ''}{
  const result = await app.${key}({ operation: '${key}', amount: 1 });
  if (!result.ok || result.value.operation !== '${key}' || result.value.status !== 'approved' || result.value.amount !== 1) throw Error('WrongOperation:${key}');
  completed++;
}`).join('\n') + (segmented ? `\nfor (const run of [${keys.map(key => `run${key}`).join(',')}]) await run();\n` : '') + '\nconsole.log(JSON.stringify({ completed }));\n');
}
async function main() {
  if (process.argv.length > 2) throw Error('Usage: node scripts/check-business-scale.mjs');
  const files = ['package.json', 'package-lock.json', 'src/experiments/business.ts', ...readdirSync(join(root, 'src/framework')).filter(name => name.endsWith('.ts')).map(name => `src/framework/${name}`)].sort();
  const hashes = Object.fromEntries(files.map(file => [file, hash(readFileSync(join(root, file)))]));
  const gitCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const sourceDirty = run('git', ['status', '--porcelain', '--', ...files]).stdout.length > 0;
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-business-scale-'));
  try {
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory]).stdout)[0];
    const tarball = readFileSync(join(directory, packed.filename));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { koyuki: `file:${join(directory, packed.filename)}` } }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], directory);
    const compiler = join(root, 'node_modules/typescript/bin/tsc');
    const flags = ['--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--noUncheckedIndexedAccess', '--types', '', '--lib', 'ES2022,DOM'];
    const results = [];
    for (const operations of [100, 500]) {
      const valid = fixture(operations), invalid = fixture(operations, true);
      writeFileSync(join(directory, 'valid.ts'), valid); writeFileSync(join(directory, 'invalid.ts'), invalid);
      const checked = run(process.execPath, [compiler, ...flags, '--outDir', 'emitted', 'valid.ts'], directory);
      const rejected = command(process.execPath, [compiler, ...flags, '--noEmit', 'invalid.ts'], directory);
      assert(rejected.status !== null && rejected.status > 0 && rejected.signal === null, rejected.stdout + rejected.stderr);
      const diagnostics = [...rejected.stdout.matchAll(/invalid\.ts\((\d+),\d+\): error TS\d+:/g)];
      assert.equal(diagnostics.length, operations, rejected.stdout);
      assert.equal([...rejected.stdout.matchAll(/error TS\d+:/g)].length, operations, rejected.stdout);
      const lines = invalid.split('\n');
      assert.deepEqual(diagnostics.map(match => lines[Number(match[1]) - 1]?.match(/^(op\d+):/)?.[1]).sort(), Array.from({ length: operations }, (_, index) => `op${index}`).sort());
      const executed = run(process.execPath, [join(directory, 'emitted/valid.js')], directory);
      assert.deepEqual(JSON.parse(executed.stdout), { completed: operations });
      results.push({ operations, validSourceSha256: hash(valid), invalidSourceSha256: hash(invalid), rejectedMissingAuthorization: diagnostics.length,
        verifiedInputOutputPairs: operations, rejectedWrongInputs: operations, executedOperations: operations,
        validCompileAndEmitMs: checked.elapsedMs, invalidCheckMs: rejected.elapsedMs, emittedProcessMs: executed.elapsedMs });
    }
    const monolithic = [];
    for (const plain of [false, true]) {
      const source = fixture(500, false, false, plain);
      writeFileSync(join(directory, 'monolithic.ts'), source);
      const result = command(process.execPath, [compiler, ...flags, '--noEmit', 'monolithic.ts'], directory);
      assert(result.status !== null && result.status > 0 && result.signal === null, result.stdout + result.stderr);
      assert.match(result.stdout, /error TS2563:/);
      monolithic.push({ style: plain ? 'plain-TypeScript-no-imports' : 'Koyuki', sourceSha256: hash(source), diagnostic: 'TS2563', scope: '500-inline-contract-and-result-check-blocks-in-one-module-body' });
    }
    for (const file of files) assert.equal(hash(readFileSync(join(root, file))), hashes[file], 'Scale source changed during execution');
    console.log(JSON.stringify({ schema: 'koyuki.business-scale.v1', node: process.version,
      compiler: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version,
      source: { gitCommit, sourceDirty, hashes }, platform: process.platform, arch: process.arch,
      tarballSha256: hash(tarball), collectorSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
      results, monolithic, loaderMode: 'operation-local-only', scope: 'generated-independent-operation-types-and-success-paths',
      exclusions: ['real-business-specification', 'editor-responsiveness', 'human-productivity', 'database', 'transport', 'long-stage-chains', 'performance-comparison'] }, null, 2));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
