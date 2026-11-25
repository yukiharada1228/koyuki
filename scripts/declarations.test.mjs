import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeDeclarations } from './check-declarations.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const analyze = source => analyzeDeclarations([{ file: 'sample.ts', source }]);

test('workflow chains diagnose ambiguous trace labels through const references and explicit branches', () => {
  const result = analyze(`import {workflow as flow} from 'koyuki';
const base = flow('load', neverExecute);
const branch = base.then('check', neverExecute).branch('choice', neverExecute, {
 yes: flow('load', neverExecute), no: flow('check', neverExecute)
}).then('choice:yes', neverExecute);`);
  assert.deepEqual(result.diagnostics.map(item => item.code), Array(3).fill('AMBIGUOUS_WORKFLOW_LABEL'));
  assert(result.diagnostics.every(item => item.severity === 'warning' && item.related.length === 1 && item.line > 0 && item.column > 0));
  assert.deepEqual(result.unresolved, []);
});

test('workflow diagnostics preserve independent scopes and do not duplicate prefix warnings', () => {
  const result = analyze(`import * as k from 'koyuki';
const first = k.workflow('same', rule).then('same', rule);
const second = first.then('end', rule);
const independent = k.workflow('same', rule);
function hidden(k) { return k.workflow('same', rule).then('same', rule); }
const unrelated = other.workflow('same', rule).then('same', rule);`);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'AMBIGUOUS_WORKFLOW_LABEL');
  assert.deepEqual(result.unresolved, []);
});

test('dynamic workflow labels and imported branch bodies remain unresolved without guessing', () => {
  const result = analyze(`import {workflow} from 'koyuki';
const path = workflow(dynamicName(), rule).then('known', rule).branch('choice', predicate, {yes: importedPath, no: workflow('other',rule)});`);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.unresolved.length, 2);
  assert(result.unresolved.every(item => item.line > 0 && item.reason));
});

test('workflow expansion is bounded and cyclic references remain unresolved', () => {
  const names = ['const base = workflow("first", rule);'];
  for (let index = 0; index < 11; index++) names.push(`const branch${index} = base.branch('branch${index}', predicate, {yes:${index ? `branch${index - 1}` : 'base'},no:${index ? `branch${index - 1}` : 'base'}});`);
  const result = analyze(`import {workflow} from 'koyuki';\n${names.join('\n')}`);
  assert(result.unresolved.some(item => /expansion limit/.test(item.reason)));
  const cycle = analyze(`import {workflow} from 'koyuki'; const tree = workflow('start',rule).branch('choose', predicate, {yes: tree, no: workflow('end',rule)});`);
  assert(cycle.unresolved.some(item => /cyclic/.test(item.reason)));
});

test('shipping workflow metadata is checked without executing its validation or branch predicate', async () => {
  const file = 'src/shipping/domain.ts';
  const result = analyzeDeclarations([{ file, source: await readFile(join(root, file), 'utf8') }]);
  assert.equal(result.checkedDeclarations, 3);
  assert.deepEqual(result.diagnostics, []); assert.deepEqual(result.unresolved, []);
});

test('transition diagnostics report both source locations and do not confuse independent flows', () => {
  const result = analyze(`import {defineTransition as transition, step as named} from 'koyuki';
const requirement = named('same', value => value);
transition({validate:named('same', value=>value), require:[requirement], evolve:value=>value});
transition({validate:named('same', value=>value), evolve:value=>value});`);
  assert.equal(result.checkedDeclarations, 2); assert.equal(result.diagnostics.length, 1);
  const item = result.diagnostics[0];
  assert.equal(item.code, 'AMBIGUOUS_STEP_LABEL'); assert.equal(item.severity, 'warning');
  assert.equal(item.line, 2); assert.equal(item.related[0].line, 3);
  assert(item.column > 1 && item.related[0].column > 1);
});

test('operation IDs are scoped to selected source declarations and remain warnings for intentional sharing', () => {
  const result = analyzeDeclarations([
    { file: 'first.ts', source: `import {defineTarget} from 'koyuki'; const shared='save.v1'; const a=defineTarget({operation:shared});` },
    { file: 'second.ts', source: `import * as k from 'koyuki'; const b=k.defineTarget({operation:'save.v1'});` },
  ]);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].code, 'REPEATED_OPERATION_ID');
  assert.equal(result.diagnostics[0].file, 'second.ts'); assert.equal(result.diagnostics[0].related[0].file, 'first.ts');
  assert.equal(result.diagnostics[0].severity, 'warning');
});

test('default business IDs include string and numeric keys and collide with explicit IDs at the operation position', () => {
  const result = analyze(`import {business,defineTarget} from 'koyuki';
const prefix='expense'; const table={approve:[approve],0:[submit]} as const;
business({name:prefix,operations:table});
defineTarget({operation:'expense.approve'});
defineTarget({operation:'expense.0'});`);
  assert.equal(result.checkedDeclarations, 3); assert.deepEqual(result.unresolved, []);
  assert.equal(result.diagnostics.length, 2);
  for (const item of result.diagnostics) {
    assert.equal(item.code, 'REPEATED_OPERATION_ID'); assert.equal(item.related[0].line, 2);
  }
  assert.notEqual(result.diagnostics[0].related[0].column, result.diagnostics[1].related[0].column);
});

test('custom business resolvers and dynamic names remain unresolved instead of inventing default IDs', () => {
  const result = analyze(`import {business,defineTarget} from 'koyuki';
business({name:'expense',operation:()=>{throw new Error('must not execute')},operations:{approve:[approve]}});
business({name:computeName(),operations:{approve:[approve]}});
defineTarget({operation:'expense.approve'});`);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 2);
  assert(result.unresolved.some(item => item.reason.includes('resolver')));
  assert(result.unresolved.some(item => item.reason.includes('name')));
});

test('prototype setters are unresolved while computed prototype-like data keys keep their business IDs', () => {
  const result = analyze(`import {business,defineTarget} from 'koyuki';
business({name:'unsafe',operations:{__proto__:[approve]}});
business({name:'safe',operations:{['__proto__']:[approve],constructor:[approve]}});
defineTarget({operation:'safe.__proto__'}); defineTarget({operation:'safe.constructor'});`);
  assert.equal(result.unresolved.length, 1); assert.equal(result.diagnostics.length, 2);
  assert(result.diagnostics.every(item => item.code === 'REPEATED_OPERATION_ID'));
});

test('lexical shadowing, unrelated modules, and type-only imports do not masquerade as Koyuki declarations', () => {
  const result = analyze(`import {defineTarget as target} from 'koyuki';
import * as k from 'koyuki';
import {defineApplication} from 'unrelated';
import type {defineTransition} from 'koyuki';
function example(target, k) { target({operation:'x'}); k.defineTarget({operation:'x'}); }
defineApplication({operations:{dismiss:foo}});
defineTransition({validate:foo});`);
  assert.equal(result.checkedDeclarations, 0); assert.deepEqual(result.diagnostics, []);
});

test('dynamic declarations remain unresolved and reserved Application operations are positioned errors', () => {
  const result = analyze(`import {defineTarget,defineTransition,defineApplication,business} from 'koyuki';
defineTarget({...external});
defineTarget({operation:computeId()});
defineTransition({validate:stepFactory(), require:[...requirements], evolve:finish});
defineApplication({operations:{dismiss:entry, ['@complete']:entry}});
business({operations:buildOperations()});`);
  assert.equal(result.diagnostics.filter(item => item.code === 'RESERVED_APPLICATION_OPERATION').length, 2);
  assert(result.diagnostics.every(item => item.line === 5 && item.severity === 'error'));
  assert.equal(result.unresolved.length, 6);
});

test('valid shared callbacks and save names are not treated as duplicate IDs or generic function errors', () => {
  const result = analyze(`import {defineTarget,defineTransition,step} from 'koyuki';
const one=defineTarget({operation:'create.v1',save}); const two=defineTarget({operation:'update.v1',save});
defineTransition({validate:step('validate',common),require:[step('require',common)],evolve:step('evolve',common)});
defineTransition({validate:step('validate',common),evolve:step('evolve',common)});`);
  assert.equal(result.checkedDeclarations, 4); assert.deepEqual(result.diagnostics, []); assert.deepEqual(result.unresolved, []);
});

test('an imported stage may be a Step object; do not invent its default label', () => {
  const result = analyze(`import {defineTransition,step} from 'koyuki';
import {unknownStage} from './domain.js';
defineTransition({validate:unknownStage,evolve:step('validate',finish)});`);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 1);
});

test('TS assertions and TSX presentations use the appropriate parser mode', () => {
  const result = analyzeDeclarations([
    { file: 'assertion.ts', source: `import {defineTarget} from 'koyuki'; const id=<string>'save'; defineTarget({operation:'save.v1'});` },
    { file: 'view.tsx', source: `import {defineApplication} from 'koyuki'; defineApplication({operations:{go:entry},view:()=> <div/>});` },
  ]);
  assert.equal(result.checkedDeclarations, 2); assert.deepEqual(result.diagnostics, []);
});

test('real tag and expense declarations are parsed without loading their repositories or checking domain function bodies', async () => {
  const paths = ['src/tags/model.ts', 'src/tags/events.ts', 'src/expenses/application.ts'];
  const files = await Promise.all(paths.map(async file => ({ file, source: await readFile(join(root, file), 'utf8') })));
  const result = analyzeDeclarations(files);
  assert.equal(result.checkedDeclarations, 11); assert.deepEqual(result.diagnostics, []); assert.deepEqual(result.unresolved, []);
});

test('all 25 procurement business IDs are checked without executing the application', async () => {
  const file = 'src/experiments/procurement/application.ts';
  const source = await readFile(join(root, file), 'utf8');
  const baseline = analyzeDeclarations([{ file, source }]);
  assert.equal(baseline.checkedDeclarations, 6); assert.equal(baseline.checkedOperationIds, 25);
  assert.deepEqual(baseline.diagnostics, []); assert.deepEqual(baseline.unresolved, []);
  const expected = {
    request: ['create', 'edit', 'withdraw', 'reject', 'return', 'reassign', 'submit', 'approve'],
    order: ['place', 'amend', 'cancel', 'complete'], receipt: ['receive', 'return', 'correct'],
    invoice: ['register', 'approve', 'void', 'match'], payment: ['record', 'cancel'], inventory: ['reserve', 'release', 'move', 'adjust'],
  };
  const duplicates = Object.entries(expected).flatMap(([model, operations]) => operations.map(name => `diagnosticTarget({operation:${JSON.stringify(`procurement.${model}.v1.${name}`)}});`)).join('\n');
  const checked = analyzeDeclarations([{ file, source: source + `\nimport {defineTarget as diagnosticTarget} from 'koyuki';\n` + duplicates }]);
  assert.equal(checked.checkedOperationIds, 50); assert.equal(checked.diagnostics.length, 25);
  assert(checked.diagnostics.every(item => item.code === 'REPEATED_OPERATION_ID' && item.related.length === 1));
});

test('CLI never evaluates imports, top-level effects, or getters; JSON and strict exits are stable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'koyuki-declaration-cli-'));
  try {
    const source = join(temporary, 'source.ts'), marker = join(temporary, 'executed');
    await writeFile(source, `import {writeFileSync} from 'node:fs';
import {defineTarget,defineApplication,workflow} from 'koyuki';
import './does-not-exist.js';
writeFileSync(${JSON.stringify(marker)}, 'executed');
throw new Error('must not run');
const a=defineTarget({operation:'same'}); const b=defineTarget({operation:'same'});
const flow=workflow('stage', () => { throw Error('rule must not execute'); })
  .then('stage', (() => { writeFileSync(${JSON.stringify(marker)}, 'argument'); throw Error('argument must not execute'); })());
defineApplication({get operations(){writeFileSync(${JSON.stringify(marker)}, 'getter');return {};}});`);
    const run = flags => spawnSync(process.execPath, ['scripts/check-declarations.mjs', ...flags, source], { cwd: root, encoding: 'utf8' });
    const plain = run(['--json']); assert.equal(plain.status, 0, plain.stderr);
    const report = JSON.parse(plain.stdout); assert.equal(report.diagnostics.length, 2); assert.equal(report.unresolved.length, 1);
    assert.equal(run(['--strict']).status, 1);
    await assert.rejects(access(marker));
    await writeFile(source, 'const broken = (');
    const invalid = run(['--json']); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).diagnostics[0].code, 'PARSE_ERROR');
    const usage = spawnSync(process.execPath, ['scripts/check-declarations.mjs'], { cwd: root, encoding: 'utf8' }); assert.equal(usage.status, 2);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
