import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(args, cwd = root, expectFailure = false) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
  assert(result.status !== null && (expectFailure ? result.status !== 0 : result.status === 0), (result.stdout ?? '') + (result.stderr ?? ''));
  return result.stdout;
}
const temp = mkdtempSync(join(tmpdir(), 'koyuki-expense-budget-package-'));
try {
  run(['run', 'build']);
  const pack = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temp]))[0];
  const consumer = join(temp, 'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { koyuki: `file:../${pack.filename}` }, devDependencies: { typescript: '7.0.2', tsx: '4.23.15', '@types/node': 'latest' } }));
  const files = ['src/expense-budget.test.tsx', 'src/expenses/domain.ts', 'src/examples/expense.ts', ...['domain.ts','repository.ts','application.tsx','sqlite.ts','memory.ts','plain.ts','contracts.ts'].map(name => `src/experiments/expense-budget/${name}`)];
  for (const file of files) {
    const target = join(consumer, file); mkdirSync(dirname(target), { recursive: true });
    const source = readFileSync(join(root, file), 'utf8').replace(/from '(?:\.\.?\/)+framework\/(index|authoring)\.js'/g, (_all, entry) => `from '${entry === 'index' ? 'koyuki' : 'koyuki/experimental'}'`);
    assert(!source.includes('/framework/'), `Private import in ${file}`);
    writeFileSync(target, source);
  }
  const config = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: ['node'], noUncheckedIndexedAccess: true, jsx: 'react', jsxFactory: 'h', declaration: true, emitDeclarationOnly: true, outDir: 'declarations', rootDir: 'src' }, include: ['src'] };
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(config));
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const version of ['7.0.2','6.0.3']) {
    if (version === '6.0.3') run(['install','--save-dev',`typescript@${version}`,'--ignore-scripts','--no-audit','--no-fund'], consumer);
    run(['exec','--','tsc','-p','tsconfig.json'], consumer);
    writeFileSync(join(consumer, 'consumer.ts'), `import { submission, correction, editing } from './declarations/experiments/expense-budget/application.js';
import { createApplicationTemplate, h, Operation } from 'koyuki/experimental';
import type { Result, Execution, ReplayInputError } from 'koyuki';
import type { ExpenseState } from './declarations/expenses/domain.js';
import type { DomainError } from './declarations/experiments/expense-budget/domain.js';
import type { StorageError } from './declarations/experiments/expense-budget/repository.js';
const app = createApplicationTemplate(h(Operation, { operation: submission })).scope(children => children);
// Compile-only client; the real runtime supplies Providers.
function check() {
  const result = app.execute(submission, {id:'one',expectedVersion:1,requestId:'one'});
  type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  type Expect<T extends true> = T;
  type ExactResult = Expect<Equal<typeof result, Promise<Result<Execution<ExpenseState>, DomainError | StorageError | ReplayInputError>>>>;
  const exact: ExactResult = true; void exact;
  // @ts-expect-error Returning requires a reason, even through emitted declarations.
  app.execute(correction, {id:'one',expectedVersion:1,requestId:'one'});
  // @ts-expect-error Editing requires amount and receipt.
  app.execute(editing, {id:'one',expectedVersion:1,requestId:'one'});
}
void check;`);
    writeFileSync(join(consumer, 'declaration-client.json'), JSON.stringify({ compilerOptions: { ...config.compilerOptions, rootDir: '.', noEmit: true, emitDeclarationOnly: false }, files: ['consumer.ts'] }));
    run(['exec','--','tsc','-p','declaration-client.json'], consumer);
    console.log(`TypeScript ${version}: public imports, sample contracts and generated declarations passed.`);
  }
  console.log(run(['exec','--','tsx','--test','src/expense-budget.test.tsx'], consumer));
  const adapter = join(consumer, 'src/experiments/expense-budget/sqlite.ts');
  const original = readFileSync(adapter, 'utf8');
  const mutation = original.replace(' || change.budget.version !== budget.version', '');
  assert.notEqual(mutation, original);
  writeFileSync(adapter, mutation);
  const failed = run(['exec','--','tsx','--test','src/expense-budget.test.tsx'], consumer, true);
  assert(failed.includes('changed budget revision conflicts'), 'Failure must identify the budget revision contract');
  console.log('Negative control: removing budget revision comparison was detected.');
  writeFileSync(adapter, original);
  // Specification-change study in the installed consumer, never in the user's tree.
  const changed = [];
  for (const file of ['src/expenses/domain.ts', 'src/examples/expense.ts']) {
    const path = join(consumer, file), before = readFileSync(path, 'utf8'), after = before.replaceAll('100000', '50000');
    assert.notEqual(after, before);
    changed.push({ file, changedLines: before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length });
    writeFileSync(path, after);
  }
  const testFile = join(consumer, 'src/expense-budget.test.tsx');
  const beforeTest = readFileSync(testFile, 'utf8');
  const afterTest = beforeTest.replace("[{ amount: 99999, expected: 'approved' }, { amount: 100000, expected: 'approved' }, { amount: 100001, expected: 'finance' }]", "[{ amount: 49999, expected: 'approved' }, { amount: 50000, expected: 'approved' }, { amount: 50001, expected: 'finance' }]");
  assert.notEqual(afterTest, beforeTest);
  writeFileSync(testFile, afterTest);
  run(['exec','--','tsc','-p','tsconfig.json'], consumer);
  run(['exec','--','tsx','--test','src/expense-budget.test.tsx'], consumer);
  console.log(JSON.stringify({ specificationChange: 'finance threshold 100000 -> 50000', sharedDomainChanges: changed, testFixtureChangedLines: 1, koyukiWiringChangedLines: 0, plainWiringChangedLines: 0, adapterChangedLines: 0, conclusion: 'Both benefit equally from the shared pure domain. No Koyuki-specific change-count advantage is established by this case.' }));


} finally { rmSync(temp, { recursive: true, force: true }); }
