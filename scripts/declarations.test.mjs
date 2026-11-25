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

test('CLI never evaluates imports, top-level effects, or getters; JSON and strict exits are stable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'koyuki-declaration-cli-'));
  try {
    const source = join(temporary, 'source.ts'), marker = join(temporary, 'executed');
    await writeFile(source, `import {writeFileSync} from 'node:fs';
import {defineTarget,defineApplication} from 'koyuki';
import './does-not-exist.js';
writeFileSync(${JSON.stringify(marker)}, 'executed');
throw new Error('must not run');
const a=defineTarget({operation:'same'}); const b=defineTarget({operation:'same'});
defineApplication({get operations(){writeFileSync(${JSON.stringify(marker)}, 'getter');return {};}});`);
    const run = flags => spawnSync(process.execPath, ['scripts/check-declarations.mjs', ...flags, source], { cwd: root, encoding: 'utf8' });
    const plain = run(['--json']); assert.equal(plain.status, 0, plain.stderr);
    const report = JSON.parse(plain.stdout); assert.equal(report.diagnostics.length, 1); assert.equal(report.unresolved.length, 1);
    assert.equal(run(['--strict']).status, 1);
    await assert.rejects(access(marker));
    await writeFile(source, 'const broken = (');
    const invalid = run(['--json']); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).diagnostics[0].code, 'PARSE_ERROR');
    const usage = spawnSync(process.execPath, ['scripts/check-declarations.mjs'], { cwd: root, encoding: 'utf8' }); assert.equal(usage.status, 2);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
