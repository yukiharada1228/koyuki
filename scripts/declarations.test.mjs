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

test('business expands explicit Workflow names into the same scope as ordinary functions and Steps', () => {
  const result = analyze(`import {business,workflow,step} from 'koyuki';
const rule=value=>value;
const flow=workflow('run:1',rule).then('validate',rule);
business({name:'mixed',operations:{apply:[rule,flow,step('validate',rule)],other:[flow]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 6); assert.equal(result.checkedOperationIds, 2);
  assert.deepEqual(result.unresolved, []); assert.equal(result.diagnostics.length, 2);
  assert(result.diagnostics.every(item => item.code === 'AMBIGUOUS_BUSINESS_RULE_LABEL'));
  assert.match(result.diagnostics[0].message, /run:1/); assert.match(result.diagnostics[1].message, /validate/);
});

test('known Workflow run references remain ordinary opaque business stages with positional labels', () => {
  const result = analyze(`import {business,workflow} from 'koyuki'; const rule=value=>value;
const flow=workflow('inner',rule).then('run:1',rule);
business({name:'opaque',operations:{apply:[flow.run,flow['run'],flow]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 4); assert.deepEqual(result.unresolved, []);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].code, 'AMBIGUOUS_BUSINESS_RULE_LABEL');
  assert.match(result.diagnostics[0].message, /run:1/);
});

test('reused Workflow business references point to the distinct connection sites', () => {
  const result = analyze(`import {business,workflow} from 'koyuki';
const flow=workflow('first',rule).then('second',rule);
business({name:'reuse',operations:{apply:[flow,flow],other:[flow]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 6); assert.deepEqual(result.unresolved, []);
  assert.equal(result.diagnostics.length, 2);
  for (const item of result.diagnostics) {
    assert.equal(item.code, 'AMBIGUOUS_BUSINESS_RULE_LABEL'); assert.equal(item.line, 3); assert.equal(item.related[0].line, 3);
    assert(item.column > item.related[0].column);
  }
});

test('business Workflow diagnostics include both branch alternatives without asserting simultaneous execution', () => {
  const result = analyze(`import {business,workflow,step} from 'koyuki';
const flow=workflow('check',rule).branch('choose',()=>{throw Error('predicate')},{yes:workflow('approved',rule),no:workflow('rejected',rule)});
business({name:'branch',operations:{apply:[step('choose:yes',rule),flow]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 6); assert.deepEqual(result.unresolved, []);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].code, 'AMBIGUOUS_BUSINESS_RULE_LABEL');
  assert.match(result.diagnostics[0].message, /choose:yes/); assert.match(result.diagnostics[0].message, /Branch alternatives/);
});

test('partially static business Workflows retain resolved names and positioned unresolved metadata', () => {
  const result = analyze(`import {business,workflow,step} from 'koyuki';
const flow=workflow(compute(),rule).then('stable',rule).branch('choose',predicate,{yes:external,no:workflow('other',rule)});
business({name:'partial',operations:{apply:[flow,step('stable',rule)]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 5);
  const unresolved = result.unresolved.filter(item => item.reason.startsWith('apply[0]:'));
  assert.equal(unresolved.length, 2); assert(unresolved.every(item => item.file === 'sample.ts' && item.line === 2));
  assert(unresolved.some(item => /dynamic/.test(item.reason))); assert(unresolved.some(item => /unresolved/.test(item.reason)));
  assert.equal(result.diagnostics.filter(item => item.code === 'AMBIGUOUS_BUSINESS_RULE_LABEL').length, 1);
});

test('selected Workflow exports expand in business in either source order without discovering files', () => {
  const files = [
    { file: 'selected/main.ts', source: `import {business} from 'koyuki'; import {flow as selected} from './flow.js';
const rule=value=>value;
business({name:'selected',operations:{apply:[rule,selected]}});` },
    { file: 'selected/flow.ts', source: `import {workflow} from 'koyuki'; export const flow=workflow('run:1',rule).then('finish',rule);` },
  ];
  const alone = analyzeDeclarations([files[0]]); assert.equal(alone.unresolved.length, 1); assert.equal(alone.checkedBusinessRuleLabels, 1);
  for (const selected of [files, [...files].reverse()]) {
    const result = analyzeDeclarations(selected); assert.deepEqual(result.unresolved, []); assert.equal(result.checkedBusinessRuleLabels, 3);
    assert.equal(result.diagnostics.length, 1); const item = result.diagnostics[0];
    assert.equal(item.file, 'selected/main.ts'); assert.equal(item.related[0].file, 'selected/main.ts'); assert.equal(item.line, 3);
    assert(item.column > item.related[0].column);
  }
});

test('business does not infer Workflows from shadowed factories, conditional candidates or foreign run properties', () => {
  const result = analyze(`import {business,workflow as build} from 'koyuki';
const real=build('real',rule);
function local(workflow){const foreign=workflow('fake',rule);business({name:'shadow',operations:{apply:[foreign]}});}
business({name:'unknown',operations:{conditional:[flag?real:other],foreign:[other.run],known:[real.run,real]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 2); assert.equal(result.unresolved.length, 3); assert.deepEqual(result.diagnostics, []);
});

test('business shares its expansion budget between ordinary stages and Workflow construction calls', () => {
  const chain = "workflow('w0',rule)" + Array.from({ length: 511 }, (_, i) => `.then('w${i + 1}',rule)`).join('');
  const result = analyze(`import {business,workflow,step} from 'koyuki'; const rule=value=>value; const flow=${chain};
business({name:'bounded',operations:{first:[${Array(512).fill('rule')}],second:[flow],last:[rule,step('same',rule),step('same',rule)]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 1024); assert.equal(result.checkedOperationIds, 3);
  assert.equal(result.unresolved.length, 1); assert.match(result.unresolved[0].reason, /1024 stages or Workflow construction calls/);
  assert.deepEqual(result.diagnostics, []);
});

test('CLI expands selected business Workflows without executing modules, predicates or inner rules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'koyuki-business-flow-cli-'));
  try {
    const main = join(directory, 'main.ts'), flow = join(directory, 'flow.ts'), marker = join(directory, 'executed');
    await writeFile(main, `import {business} from 'koyuki'; import {flow} from './flow.js'; const rule=value=>value;
business({name:'cli',operations:{apply:[rule,flow]}});`);
    await writeFile(flow, `import {writeFileSync} from 'node:fs'; import {workflow} from 'koyuki';
writeFileSync(${JSON.stringify(marker)},'module'); throw Error('module');
export const flow=workflow('run:1',value=>{writeFileSync(${JSON.stringify(marker)},'rule');throw Error('rule');})
.branch('choose',()=>{writeFileSync(${JSON.stringify(marker)},'predicate');throw Error('predicate');},{yes:workflow('yes',rule),no:workflow('no',rule)});`);
    const cli = (...args) => spawnSync(process.execPath, ['scripts/check-declarations.mjs', '--json', ...args], { cwd: root, encoding: 'utf8' });
    const selected = cli(main, flow); assert.equal(selected.status, 0, selected.stderr);
    const report = JSON.parse(selected.stdout); assert.equal(report.checkedBusinessRuleLabels, 6); assert.deepEqual(report.unresolved, []);
    assert.equal(report.diagnostics.length, 1); assert.equal(report.diagnostics[0].code, 'AMBIGUOUS_BUSINESS_RULE_LABEL');
    assert.equal(cli('--strict', main, flow).status, 1);
    const alone = cli(main); assert.equal(alone.status, 0); assert.equal(JSON.parse(alone.stdout).unresolved.length, 1);
    await assert.rejects(access(marker), error => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('business rule diagnostics combine default labels, named Steps and structural Step objects per operation', () => {
  const result = analyze(`import {business,step} from 'koyuki';
const rule = value => ({ok:true,value});
business({name:'expense',operations:{
  approve:[rule,step('run:1',rule),{name:'run:1',rule}],
  reject:{load,run:[step('check',rule),step('check',rule)]}
}});`);
  assert.equal(result.checkedBusinessRuleLabels, 5); assert.equal(result.checkedOperationIds, 2);
  assert.deepEqual(result.unresolved, []); assert.equal(result.diagnostics.length, 3);
  assert(result.diagnostics.every(item => item.code === 'AMBIGUOUS_BUSINESS_RULE_LABEL' && item.severity === 'warning' && item.related.length === 1));
});

test('reused business Steps point to distinct connection sites and do not collide across operations', () => {
  const result = analyze(`import {business,step} from 'koyuki';
const checked=step('check',rule);
business({name:'one',operations:{approve:[checked,checked],reject:[checked]}});`);
  assert.equal(result.checkedBusinessRuleLabels, 3); assert.equal(result.diagnostics.length, 1);
  const item = result.diagnostics[0];
  assert.equal(item.line, 3); assert.equal(item.related[0].line, 3);
  assert(item.column > item.related[0].column); assert.deepEqual(result.unresolved, []);
});

test('business rule labels remain inspectable when operation identity is dynamic', () => {
  const result = analyze(`import {business,step} from 'koyuki';
business({name:compute(),operation:resolve,operations:{approve:[step('check',rule),step('check',rule)]}});`);
  assert.equal(result.checkedOperationIds, 0); assert.equal(result.checkedBusinessRuleLabels, 2);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].code, 'AMBIGUOUS_BUSINESS_RULE_LABEL');
  assert.equal(result.unresolved.length, 1); assert.match(result.unresolved[0].reason, /resolver/);
});

test('business dynamic stages, spreads, holes and getters stay unresolved without invented function labels', () => {
  const result = analyze(`import {business,step} from 'koyuki';
business({name:'dynamic',operations:{
  factory:makePipeline(),spread:[...rules,step('same',rule)],hole:[,rule],empty:[],
  unknown:[external,step('run:1',rule)],getter:[{get name(){throw Error('never')},rule}],
  numeric:[step(1,rule)],foreign:[other.step('same',rule)]
}});`);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 8);
  assert.equal(result.checkedBusinessRuleLabels, 1); assert.equal(result.checkedOperationIds, 8);
});

test('selected function exports and Step aliases resolve business labels without inspecting function bodies', () => {
  const files = [
    { file: 'business/main.ts', source: `import {business} from 'koyuki';
import {ordinary,named} from './rules.js';
business({name:'selected',operations:{approve:[ordinary,named]}});` },
    { file: 'business/rules.ts', source: `import {step} from 'koyuki';
export function ordinary(value){throw Error('must not execute');}
const shared=step('run:1',ordinary); export {shared as named};` },
  ];
  const alone = analyzeDeclarations([files[0]]);
  assert.equal(alone.unresolved.length, 2); assert.equal(alone.checkedBusinessRuleLabels, 0); assert.deepEqual(alone.diagnostics, []);
  for (const selected of [files, [...files].reverse()]) {
    const result = analyzeDeclarations(selected);
    assert.equal(result.checkedBusinessRuleLabels, 2); assert.deepEqual(result.unresolved, []);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].file, 'business/main.ts'); assert.equal(result.diagnostics[0].related[0].file, 'business/main.ts');
    assert(result.diagnostics[0].column > result.diagnostics[0].related[0].column);
  }
});

test('reassigned business functions and type-only imports are not assumed to be plain rules', () => {
  const result = analyze(`import {business,step,withInput} from 'koyuki';
import type {imported} from './other.js';
function changed(value){return value;} changed=makeStage();
business({name:'one',operations:{change:[changed,step('run:1',rule)],typed:[imported],wrapped:[withInput(rule)]}});`);
  assert.equal(result.unresolved.length, 2); assert.equal(result.checkedBusinessRuleLabels, 2); assert.deepEqual(result.diagnostics, []);
});

test('business stage expansion has one shared budget across operation arrays', () => {
  const source = `import {business,step} from 'koyuki'; const rule=value=>value;
business({name:'large',operations:{first:[${Array(512).fill('rule')}],second:{load,run:[${Array(513).fill('rule')}]},skipped:[step('same',rule),step('same',rule)]}});`;
  const result = analyze(source);
  assert.equal(result.checkedBusinessRuleLabels, 1024); assert.equal(result.checkedOperationIds, 3);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0].reason, /1024 stages/);
});

test('selected procurement sources resolve all 52 rule labels and detect an injected label collision', async () => {
  const paths = ['application.ts', 'domain.ts', 'inventory.ts', 'receipt-pipeline.ts', 'request-pipeline.ts'].map(name => `src/experiments/procurement/${name}`);
  const files = await Promise.all(paths.map(async file => ({ file, source: await readFile(join(root, file), 'utf8') })));
  const result = analyzeDeclarations(files);
  assert.equal(result.checkedDeclarations, 12); assert.equal(result.checkedOperationIds, 25); assert.equal(result.checkedBusinessRuleLabels, 52);
  assert.deepEqual(result.diagnostics, []); assert.deepEqual(result.unresolved, []);
  const mutated = files.map(file => file.file !== paths[0] ? file : { ...file, source: file.source.replace('run: [checkBuyerRequest, submitCheckedRequest]', "run: [diagnosticStep('run:2', checkBuyerRequest), submitCheckedRequest]") + "\nimport {step as diagnosticStep} from 'koyuki';" });
  assert.notEqual(mutated[0].source, files[0].source);
  const broken = analyzeDeclarations(mutated);
  assert.equal(broken.checkedBusinessRuleLabels, 52); assert.deepEqual(broken.unresolved, []);
  assert.equal(broken.diagnostics.length, 1); assert.equal(broken.diagnostics[0].code, 'AMBIGUOUS_BUSINESS_RULE_LABEL');
  assert.equal(broken.diagnostics[0].file, paths[0]);
});

test('business CLI diagnostics never execute selected modules, stage bodies or operation resolvers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'koyuki-business-cli-'));
  try {
    const main = join(directory, 'main.ts'), rules = join(directory, 'rules.ts'), marker = join(directory, 'executed');
    await writeFile(main, `import {business} from 'koyuki'; import {ordinary,named} from './rules.js';
business({name:'cli',operation:()=>{throw Error('resolver')},operations:{approve:[ordinary,named]}});`);
    await writeFile(rules, `import {writeFileSync} from 'node:fs'; import {step} from 'koyuki';
writeFileSync(${JSON.stringify(marker)},'executed'); throw Error('module');
export function ordinary(value){writeFileSync(${JSON.stringify(marker)},'rule');throw Error('rule');}
export const named=step('run:1',ordinary);`);
    const run = args => spawnSync(process.execPath, ['scripts/check-declarations.mjs', '--json', ...args], { cwd: root, encoding: 'utf8' });
    const alone = run([main]); assert.equal(alone.status, 0, alone.stderr); assert.equal(JSON.parse(alone.stdout).unresolved.length, 3);
    const selected = run([main, rules]); assert.equal(selected.status, 0, selected.stderr);
    const report = JSON.parse(selected.stdout); assert.equal(report.checkedBusinessRuleLabels, 2); assert.equal(report.diagnostics.length, 1);
    assert.equal(report.unresolved.length, 1); assert.equal(run(['--strict', main, rules]).status, 1);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Process diagnostics connect explicit IO, through Workflow and bound commit labels', () => {
  const result = analyze(`import {process, workflow, bindMutation} from 'koyuki';
const flow = workflow('validate', rule);
const mutation = bindMutation({workflow: flow, operation:'save.v1', save});
const command = process().through(flow).effect('validate', io).effect('save.v1', io).commit(mutation);`);
  assert.deepEqual(result.diagnostics.map(item => item.code), Array(3).fill('AMBIGUOUS_PROCESS_LABEL'));
  assert(result.diagnostics.every(item => item.related.length === 1 && item.severity === 'warning'));
  assert.deepEqual(result.unresolved, []);
});

test('reused Workflow references identify distinct Process connection sites', () => {
  const result = analyze(`import {process as io, workflow} from 'koyuki';
const flow = workflow('validate', rule);
const command = io().through(flow)
  .through(flow);`);
  assert.equal(result.diagnostics.length, 1);
  const item = result.diagnostics[0];
  assert.equal(item.code, 'AMBIGUOUS_PROCESS_LABEL');
  assert.equal(item.line, 4); assert.equal(item.related[0].line, 3);
});

test('Process diagnostics do not guess imported metadata, dynamic labels or unrelated methods', () => {
  const result = analyze(`import * as k from 'koyuki';
const flow = k.process().through(imported).effect(dynamic(), io).commit(importedCommand);
const unrelated = other.process().effect('same', io).effect('same', io);
function hidden(k) { return k.process().effect('same', io).effect('same', io); }`);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.unresolved.length, 3);
});

test('shipping Process declarations retain unresolved imported Workflow metadata without executing ports', async () => {
  const file = 'src/shipping/feature.ts';
  const result = analyzeDeclarations([{ file, source: await readFile(join(root, file), 'utf8') }]);
  assert.equal(result.checkedDeclarations, 2); assert.equal(result.checkedOperationIds, 1);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.unresolved.length, 3);
  assert(result.unresolved.every(item => /Workflow/.test(item.reason)));
});

test('selected shipping sources resolve imported Workflow metadata in either input order', async () => {
  const paths = ['src/shipping/feature.ts', 'src/shipping/domain.ts'];
  const files = await Promise.all(paths.map(async file => ({ file, source: await readFile(join(root, file), 'utf8') })));
  for (const selected of [files, [...files].reverse()]) {
    const result = analyzeDeclarations(selected);
    assert.equal(result.checkedOperationIds, 1);
    assert.deepEqual(result.diagnostics, []); assert.deepEqual(result.unresolved, []);
  }
});

test('selected named const exports connect aliases across three source files and preserve diagnostic positions', () => {
  const files = [
    { file: 'selected/main.ts', source: `import {workflow} from 'koyuki';
import {choice as external} from './branch.js';
workflow('same', rule).branch('choice', predicate, {yes:external,no:workflow('no',rule)});` },
    { file: 'selected/branch.ts', source: `import {workflow} from 'koyuki';
import {label as importedLabel} from './label.js';
const selected = workflow(importedLabel, rule);
export {selected as choice};` },
    { file: 'selected/label.ts', source: `export const label = 'same';` },
  ];
  const result = analyzeDeclarations(files);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.diagnostics.length, 1);
  const item = result.diagnostics[0];
  assert.equal(item.code, 'AMBIGUOUS_WORKFLOW_LABEL');
  assert.equal(item.file, 'selected/branch.ts'); assert.equal(item.line, 3);
  assert.equal(item.related[0].file, 'selected/main.ts'); assert.equal(item.related[0].line, 3);
  assert.deepEqual(analyzeDeclarations([...files].reverse()).diagnostics, result.diagnostics);
  // A separate analysis must not retain imports from a previous call.
  assert.equal(analyzeDeclarations([files[0]]).unresolved.length, 1);
});

test('selected imported bindMutation and Workflow references connect Process labels without evaluating ports', () => {
  const result = analyzeDeclarations([
    { file: 'selected/main.ts', source: `import {process} from 'koyuki';
import {mutation as save} from './save.js';
process().effect('save.v1', neverExecute).commit(save);` },
    { file: 'selected/save.ts', source: `import {workflow,bindMutation} from 'koyuki';
export const mutation=bindMutation({workflow:workflow('validate',neverExecute),operation:'save.v1',save:neverExecute});` },
  ]);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'AMBIGUOUS_PROCESS_LABEL');
  assert.equal(result.diagnostics[0].file, 'selected/save.ts');
  assert.equal(result.diagnostics[0].related[0].file, 'selected/main.ts');
});

test('selected source resolver does not infer mutable, type-only, namespace or re-exported values', () => {
  const main = {file:'selected/main.ts',source:`import {process} from 'koyuki';
import {mutable, reassigned, forwarded, typed} from './values.js';
import type {onlyType} from './values.js';
import * as namespace from './values.js';
process().through(mutable).through(reassigned).through(forwarded).through(typed).through(onlyType).through(namespace.flow);`};
  const values = {file:'selected/values.ts',source:`import {workflow} from 'koyuki';
export let mutable=workflow('mutable',rule);
export const reassigned=workflow('reassigned',rule); reassigned=other;
export {flow as forwarded} from './not-selected.js';
export type {typed,onlyType} from './not-selected.js';
export const flow=workflow('flow',rule);`};
  const result=analyzeDeclarations([main,values]);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 6);
});

test('ambiguous selected module identities and cyclic imports remain unresolved', () => {
  const main={file:'selected/main.ts',source:`import {process} from 'koyuki'; import {flow} from './flow.js'; process().through(flow);`};
  const js={file:'selected/flow.js',source:`import {workflow} from 'koyuki'; export const flow=workflow('js',rule);`};
  const ts={file:'selected/flow.ts',source:`import {workflow} from 'koyuki'; export const flow=workflow('ts',rule);`};
  for (const files of [[main,js,ts],[main,ts,ts]]) {
    const result=analyzeDeclarations(files);
    assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 1);
  }
  const cycle=analyzeDeclarations([main,
    {file:'selected/flow.ts',source:`import {other} from './other.js'; export const flow=other;`},
    {file:'selected/other.ts',source:`import {flow} from './flow.js'; export const other=flow;`},
  ]);
  assert.deepEqual(cycle.diagnostics, []); assert.equal(cycle.unresolved.length, 1);
});

test('selected source resolution obeys lexical shadowing and supports explicit module extensions only', () => {
  const result=analyzeDeclarations([
    {file:'selected/main.mts',source:`import {process} from 'koyuki'; import {flow} from './flow.mjs';
process().through(flow); function hidden(flow) { return process().through(flow); }`},
    {file:'selected/flow.mts',source:`import {workflow} from 'koyuki'; export const flow=workflow('stage',rule);`},
  ]);
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 1);
});

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
  assert.equal(result.checkedDeclarations, 3); assert.equal(result.unresolved.length, 2);
  assert(result.unresolved.every(item => item.reason.includes('Business stage')));
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
  assert.deepEqual(result.diagnostics, []); assert.equal(result.unresolved.length, 4);
  assert(result.unresolved.some(item => item.reason.includes('resolver')));
  assert(result.unresolved.some(item => item.reason.includes('name')));
});

test('prototype setters are unresolved while computed prototype-like data keys keep their business IDs', () => {
  const result = analyze(`import {business,defineTarget} from 'koyuki';
business({name:'unsafe',operations:{__proto__:[approve]}});
business({name:'safe',operations:{['__proto__']:[approve],constructor:[approve]}});
defineTarget({operation:'safe.__proto__'}); defineTarget({operation:'safe.constructor'});`);
  assert.equal(result.unresolved.length, 3); assert.equal(result.diagnostics.length, 2);
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
  assert.deepEqual(baseline.diagnostics, []); assert.equal(baseline.unresolved.length, 44);
  assert.equal(baseline.checkedBusinessRuleLabels, 0);
  assert(baseline.unresolved.every(item => item.reason.includes('Business stage')));
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
import {defineTarget,defineApplication,workflow,process as io} from 'koyuki';
import './does-not-exist.js';
writeFileSync(${JSON.stringify(marker)}, 'executed');
throw new Error('must not run');
const a=defineTarget({operation:'same'}); const b=defineTarget({operation:'same'});
const flow=workflow('stage', () => { throw Error('rule must not execute'); })
  .then('stage', (() => { writeFileSync(${JSON.stringify(marker)}, 'argument'); throw Error('argument must not execute'); })());
const effect=io().effect('io', (() => { writeFileSync(${JSON.stringify(marker)}, 'port'); throw Error('port must not execute'); })()).effect('io', neverRun);
defineApplication({get operations(){writeFileSync(${JSON.stringify(marker)}, 'getter');return {};}});`);
    const run = flags => spawnSync(process.execPath, ['scripts/check-declarations.mjs', ...flags, source], { cwd: root, encoding: 'utf8' });
    const plain = run(['--json']); assert.equal(plain.status, 0, plain.stderr);
    const report = JSON.parse(plain.stdout); assert.equal(report.diagnostics.length, 3); assert.equal(report.unresolved.length, 1);
    assert.equal(run(['--strict']).status, 1);
    await assert.rejects(access(marker));
    await writeFile(source, 'const broken = (');
    const invalid = run(['--json']); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).diagnostics[0].code, 'PARSE_ERROR');
    const usage = spawnSync(process.execPath, ['scripts/check-declarations.mjs'], { cwd: root, encoding: 'utf8' }); assert.equal(usage.status, 2);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test('CLI reads selected import sources without executing either module or discovering other files', async () => {
  const temporary=await mkdtemp(join(tmpdir(),'koyuki-selected-source-cli-'));
  try {
    const main=join(temporary,'main.ts'), domain=join(temporary,'domain.ts'), marker=join(temporary,'executed');
    await writeFile(main, `import {process} from 'koyuki'; import {flow} from './domain.js';
throw Error('main must not execute'); process().effect('same',neverExecute).through(flow);`);
    await writeFile(domain, `import {workflow} from 'koyuki'; import {writeFileSync} from 'node:fs';
import './missing.js'; writeFileSync(${JSON.stringify(marker)},'executed');
export const flow=workflow('same',(() => {throw Error('rule factory must not execute');})());
const trap={get value(){writeFileSync(${JSON.stringify(marker)},'getter');}};`);
    const run=(paths,flags=[])=>spawnSync(process.execPath,['scripts/check-declarations.mjs','--json',...flags,...paths],{cwd:root,encoding:'utf8'});
    const omitted=run([main]); assert.equal(omitted.status,0,omitted.stderr);
    assert.equal(JSON.parse(omitted.stdout).unresolved.length,1);
    const selected=run([main,domain]); assert.equal(selected.status,0,selected.stderr);
    const report=JSON.parse(selected.stdout);
    assert.deepEqual(report.unresolved,[]); assert.equal(report.diagnostics.length,1);
    assert.equal(report.diagnostics[0].code,'AMBIGUOUS_PROCESS_LABEL');
    assert.equal(run([main,domain],['--strict']).status,1);
    await assert.rejects(access(marker));
  } finally {await rm(temporary,{recursive:true,force:true});}
});
