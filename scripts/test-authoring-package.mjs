import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verify = args.length === 1 && args[0] === '--verify';
const prepare = args.length === 2 && args[0] === '--prepare';
assert(verify || prepare, 'Use --verify or --prepare /path/to/new-workspace');
function run(command, args, cwd = root, expectedFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (result.error || result.status === null || (expectedFailure ? result.status === 0 : result.status !== 0)) throw new Error(output || String(result.error));
  return output;
}
const temp = mkdtempSync(join(tmpdir(), 'koyuki-authoring-'));
try {
  const workspace = verify ? join(temp, 'consumer') : resolve(args[1]);
  assert(!existsSync(workspace), 'Refusing to overwrite an existing workspace');
  run('npm', ['run', 'build']);
  const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--pack-destination', temp, '--json']))[0];
  mkdirSync(workspace); mkdirSync(join(workspace, 'domain'));
  copyFileSync(join(temp, pack.filename), join(workspace, 'koyuki-development.tgz'));
  writeFileSync(join(workspace, 'DEVELOPMENT.json'), JSON.stringify({
    baseCommit: run('git', ['rev-parse', 'HEAD']).trim(),
    frameworkWorkingTreeChanged: run('git', ['status', '--porcelain', '--', 'src/framework', 'package.json', 'tsconfig.build.json']).trim().length > 0,
    sha256: createHash('sha256').update(readFileSync(join(workspace, 'koyuki-development.tgz'))).digest('hex'),
    scope: 'Unpublished development tarball built from the current working tree; base commit alone does not identify its content.',
  }, null, 2));
  copyFileSync(join(root, 'examples/authoring/main.tsx'), join(workspace, 'main.tsx'));
  copyFileSync(join(root, 'examples/authoring/three-businesses.tsx'), join(workspace, 'three-businesses.tsx'));
  copyFileSync(join(root, 'examples/authoring/captured-exports.tsx'), join(workspace, 'captured-exports.tsx'));
  copyFileSync(join(root, 'scripts/fixtures/authoring-key-contracts.ts'), join(workspace, 'key-contracts.ts'));
  copyFileSync(join(root, 'examples/authoring/README.md'), join(workspace, 'README.md'));
  const source = (from, to, replacements) => {
    let text = readFileSync(join(root, from), 'utf8');
    for (const [before, after] of replacements) { assert(text.includes(before), `Missing import rewrite: ${before}`); text = text.replaceAll(before, after); }
    writeFileSync(join(workspace, to), text);
  };
  for (const name of ['expense', 'expense-replay', 'expense-budget', 'leave', 'leave-replay', 'registration']) source(`src/experiments/react-business/${name}.tsx`, `${name}.tsx`, [
    ["'../../framework/index.js'", "'koyuki'"], ["'../../expenses/domain.js'", "'./domain/expenses.js'"],
    ...(name === 'registration' ? [["'../../registration/domain.js'", "'./domain/registration.js'"], ["'../../registration/secrets.js'", "'./domain/registration-secrets.js'"]] : []),
    ...(name === 'expense-replay' ? [["'../../expenses/repository.js'", "'./domain/repository.js'"]] : []),
    ["'./runtime.js'", "'koyuki/experimental'"],
  ]);
  source('src/experiments/react-business/leave-domain.ts', 'leave-domain.ts', [["'../../framework/index.js'", "'koyuki'"], ["'../../expenses/domain.js'", "'./domain/expenses.js'"]]);
  copyFileSync(join(root, 'src/registration/secrets.ts'), join(workspace, 'domain/registration-secrets.ts'));
  source('src/registration/domain.ts', 'domain/registration.ts', [["'../framework/index.js'", "'koyuki'"]]);
  source('src/expenses/domain.ts', 'domain/expenses.ts', [["'../framework/index.js'", "'koyuki'"], ["'../examples/expense.js'", "'./routing.js'"]]);
  source('src/examples/expense.ts', 'domain/routing.ts', [["'../framework/index.js'", "'koyuki'"]]);
  source('src/expenses/repository.ts', 'domain/repository.ts', [["'../framework/index.js'", "'koyuki'"], ["'./domain.js'", "'./expenses.js'"]]);
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { check: 'tsc --noEmit', start: 'tsx main.tsx' }, dependencies: { koyuki: 'file:./koyuki-development.tgz' }, devDependencies: { typescript: '7.0.2', tsx: '4.23.15' } }, null, 2));
  writeFileSync(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noUncheckedIndexedAccess: true, noEmit: true, types: [], lib: ['ES2022', 'DOM'], jsx: 'react', jsxFactory: 'h' }, include: ['main.tsx', 'captured-exports.tsx', 'expense.tsx', 'expense-replay.tsx', 'expense-budget.tsx', 'leave.tsx', 'leave-replay.tsx', 'registration.tsx', 'three-businesses.tsx', 'leave-domain.ts', 'key-contracts.ts', 'domain/*.ts'] }, null, 2));
  if (verify) {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], workspace);
    for (const dependency of ['react', '@types/react', '@types/node']) assert(!existsSync(join(workspace, 'node_modules', dependency)), `Unexpected dependency: ${dependency}`);
    const preparedMain = readFileSync(join(workspace, 'main.tsx'), 'utf8');
    assert(run(process.execPath, [fileURLToPath(import.meta.url), '--prepare', workspace], root, true).includes('Refusing to overwrite an existing workspace'));
    assert.equal(readFileSync(join(workspace, 'main.tsx'), 'utf8'), preparedMain);
    for (const version of ['7.0.2', '6.0.3']) {
      if (version !== '7.0.2') run('npm', ['install', '--save-dev', `typescript@${version}`, '--ignore-scripts', '--no-audit', '--no-fund'], workspace);
      run('npm', ['run', 'check'], workspace);
      const config = join(workspace, 'tsconfig.json');
      const original = readFileSync(config, 'utf8');
      const emit = JSON.parse(original); emit.compilerOptions.noEmit = false; emit.compilerOptions.declaration = true; emit.compilerOptions.emitDeclarationOnly = true; emit.compilerOptions.outDir = './declarations';
      writeFileSync(config, JSON.stringify(emit));
      run('npm', ['exec', '--', 'tsc'], workspace);
      writeFileSync(config, original);
      const declarationClient = readFileSync(join(root, 'examples/authoring/declaration-client.tsx'), 'utf8');
      writeFileSync(join(workspace, 'declaration-client.tsx'), declarationClient);
      const clientConfig = join(workspace, 'declaration-client-config.json');
      writeFileSync(clientConfig, JSON.stringify({ compilerOptions: JSON.parse(original).compilerOptions, files: ['declaration-client.tsx'] }));
      run('npm', ['exec', '--', 'tsc', '-p', clientConfig], workspace);
      writeFileSync(join(workspace, 'declaration-client.tsx'), declarationClient.replace('const exact: Equal<typeof result, Promise<Result<Change,', 'const exact: Equal<typeof result, Promise<Result<string,'));
      assert(run('npm', ['exec', '--', 'tsc', '-p', clientConfig], workspace, true).includes('TS2322'));
      writeFileSync(join(workspace, 'declaration-client.tsx'), declarationClient);
      // Removing only the public type name must preserve ordinary checking but
      // reproduce the consumer declaration-serialization failure.
      const sdkIndex = join(workspace, 'node_modules/koyuki/dist/index.d.ts');
      const sdkDeclarations = readFileSync(sdkIndex, 'utf8');
      const processExport = "export type { Process } from './process.js';";
      assert(sdkDeclarations.includes(processExport));
      try {
        writeFileSync(sdkIndex, sdkDeclarations.replace(processExport, ''));
        const exportConfig = join(workspace, 'process-export-control.json');
        writeFileSync(exportConfig, JSON.stringify({ compilerOptions: JSON.parse(original).compilerOptions, files: ['expense-budget.tsx'] }));
        run('npm', ['exec', '--', 'tsc', '-p', exportConfig], workspace);
        writeFileSync(exportConfig, JSON.stringify({ compilerOptions: { ...emit.compilerOptions, outDir: './negative-declarations' }, files: ['expense-budget.tsx'] }));
        const failure = run('npm', ['exec', '--', 'tsc', '-p', exportConfig], workspace, true);
        assert(/TS4094|TS7056|TS2742|TS2883/.test(failure), failure);
      } finally {
        writeFileSync(sdkIndex, sdkDeclarations);
        writeFileSync(config, original);
      }
      const leaveDomain = join(workspace, 'leave-domain.ts');
      const originalDomain = readFileSync(leaveDomain, 'utf8');
      const proof = '[authorization]: true';
      assert(originalDomain.includes(proof));
      try {
        // All public fields remain valid: removing only the proof requirement
        // must make the two authorization-omission controls stop producing errors.
        writeFileSync(leaveDomain, originalDomain.replace(proof, ''));
        const diagnostics = run('npm', ['run', 'check'], workspace, true);
        const codes = [...new Set(diagnostics.match(/TS[0-9]+/g) ?? [])];
        assert.deepEqual(codes, ['TS2578'], diagnostics);
        assert(diagnostics.includes('key-contracts.ts'), diagnostics);
        assert.equal((diagnostics.match(/TS2578/g) ?? []).length, 2, diagnostics);
      } finally { writeFileSync(leaveDomain, originalDomain); }
      console.log(`TypeScript ${version}: installed experimental subpath, strict inputs/results, JSX, declaration emit and declaration-only consumer passed without Node types.`);
    }
    console.log(run('npm', ['start'], workspace).trim());
    // Runtime-only SQLite integration lives outside the Node-type-free consumer
    // compilation. Every framework import still resolves to the installed SDK.
    mkdirSync(join(workspace, 'integration'));
    source('src/registration/repository.ts', 'integration/repository.ts', [
      ["'../framework/index.js'", "'koyuki'"], ["'./domain.js'", "'../domain/registration.js'"],
    ]);
    source('src/registration/replay-repository.ts', 'integration/replay-repository.ts', [
      ["'../framework/index.js'", "'koyuki'"], ["'./domain.js'", "'../domain/registration.js'"],
      ["'./secrets.js'", "'../domain/registration-secrets.js'"],
      ["'../experiments/react-business/registration.js'", "'../registration.js'"],
    ]);
    source('src/authoring-registration.test.tsx', 'integration/registration.test.tsx', [
      ["'./framework/authoring.js'", "'koyuki/experimental'"], ["'./framework/index.js'", "'koyuki'"],
      ["'./experiments/react-business/registration.js'", "'../registration.js'"],
      ["'./registration/replay-repository.js'", "'./replay-repository.js'"],
      ["'./registration/secrets.js'", "'../domain/registration-secrets.js'"],
    ]);
    console.log(run('npm', ['exec', '--', 'tsx', '--test', 'integration/registration.test.tsx'], workspace).trim());
    console.log('Installed experimental registration: SQLite restart, confirmation, atomic outbox/receipt rollback, concurrent replay and identity binding passed.');
    const businessDomain = join(workspace, 'leave-domain.ts');
    const validDomain = readFileSync(businessDomain, 'utf8');
    const selfApprovalGuard = "  if (actor.id === current.owner) return err('SelfApproval');\n";
    assert(validDomain.includes(selfApprovalGuard));
    try {
      writeFileSync(businessDomain, validDomain.replace(selfApprovalGuard, ''));
      run('npm', ['run', 'check'], workspace);
      const failure = run('npm', ['start'], workspace, true);
      assert(failure.includes('leave self-approval was allowed or changed state'), failure);
    } finally { writeFileSync(businessDomain, validDomain); }
    console.log('A type-correct missing self-approval guard was rejected by the business execution check.');

    const main = join(workspace, 'main.tsx'), original = readFileSync(main, 'utf8');
    writeFileSync(main, original.replace('commits === 1', 'commits === 2'));
    assert(run('npm', ['start'], workspace, true).includes('replay repeated business work'));
    writeFileSync(main, original);
    console.log('Installed authoring replay assertion negative control rejected an incorrect expected commit count.');
  } else console.log(`Prepared ${workspace}. Run npm install, npm run check and npm start there. No npm registry publication was performed.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
