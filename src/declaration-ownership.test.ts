import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, process, business, transition, bindMutation, defineAction, defineCommand, describeFlow, ok, type Result } from './framework/index.js';

test('transition owns the declared stage names and rule references without freezing caller records', () => {
  const validate = { name: 'validate-original', rule: (n: number) => ok(n + 1) };
  const evolve = { name: 'evolve-original', rule: (n: number) => ok(n + 1) };
  const flow = transition({ validate, require: [], evolve }), before = describeFlow(flow);
  validate.name = 'validate-replaced'; validate.rule = n => ok(n + 10);
  evolve.name = 'evolve-replaced'; evolve.rule = n => ok(n + 100);
  const report = flow.inspect(1);
  assert.deepEqual(report.result, ok(3));
  assert.deepEqual(report.trace.map(row => row.step), ['validate-original', 'evolve-original']);
  assert.deepEqual(describeFlow(flow), before);
  assert(describeFlow(flow, report.trace).nodes.every(node => node.match === 'ok'));
  assert.equal(validate.name, 'validate-replaced'); // caller still owns its source object
});
test('branch owns its declared path references', () => {
  const paths = { yes: workflow('original-yes', (n: number) => ok(n + 1)), no: workflow('original-no', (n: number) => ok(n - 1)) };
  const flow = workflow('input', (n: number) => ok(n)).branch('choose', n => n > 0, paths);
  paths.yes = workflow('replacement', (n: number) => ok(n + 100));
  const report = flow.inspect(1);
  assert.deepEqual(report.result, ok(2));
  assert(report.trace.some(row => row.step === 'original-yes'));
  assert(!report.trace.some(row => row.step === 'replacement'));
});
test('mutation owns workflow, save, operation and optional renderer selection and keeps the save receiver', async () => {
  const config = {
    workflow: workflow('rule-original', (n: number) => ok(n + 1)), operation: 'save-original', factor: 3,
    async save(n: number): Promise<Result<number, never>> { return ok(n * this.factor); },
  };
  const command = bindMutation(config);
  config.workflow = workflow('rule-replaced', (n: number) => ok(n + 100)); config.operation = 'save-replaced'; config.save = async n => ok(n + 1000);
  Object.assign(config, { render: () => { throw Error('late renderer must not be selected'); } });
  const report = await command.runDetailed(1);
  assert.deepEqual(report.result, ok(6));
  assert.deepEqual(report.trace.map(row => row.step), ['rule-original', 'save-original']);
  assert(describeFlow(command, report.trace).nodes.every(node => node.match === 'ok'));
  config.factor = 4; // host state read by the original callback remains live
  assert.deepEqual(await command.run(1), ok(8));
});
test('action owns its loader, load label and mutation while retaining the loader receiver', async () => {
  const mutation = bindMutation({ workflow: workflow('rule-original', (n: number) => ok(n * 2)), operation: 'save-original', save: async (n: number) => ok(n) });
  const config = { loadName: 'load-original', offset: 1, async load(n: number) { return ok(n + this.offset); }, mutation };
  const command = defineAction(config);
  config.loadName = 'load-replaced'; config.load = async n => ok(n + 100);
  config.mutation = bindMutation({ workflow: workflow('rule-replaced', (n: number) => ok(n)), operation: 'save-replaced', save: async (n: number) => ok(n) });
  const report = await command.runDetailed(1);
  assert.deepEqual(report.result, ok(4));
  assert.deepEqual(report.trace.map(row => row.step), ['load-original', 'rule-original', 'save-original']);
  assert(describeFlow(command, report.trace).nodes.every(node => node.match === 'ok'));
});


test('replaced execution methods invalidate object metadata without invoking accessors or changing old aliases', async () => {
  const command = defineCommand({ operation: 'save', load: async (n: number) => ok(n), decide: workflow('original', (n: number) => ok(n + 1)), save: async (n: number) => ok(n) });
  const originalRun = command.run, before = describeFlow(originalRun);
  command.run = async n => ok(n + 100);
  assert.deepEqual(describeFlow(command).nodes.map(node => node.role), ['unknown']);
  assert.deepEqual(describeFlow(originalRun), before); assert.deepEqual(await originalRun(1), ok(2));
  Object.defineProperty(command, 'runDetailed', { get(): never { throw Error('metadata must not call a getter'); } });
  assert.deepEqual(describeFlow(command).nodes.map(node => node.role), ['unknown']);
});


test('Process captures detailed effect and commit methods with their original receivers', async () => {
  const loader = { offset: 2, async runDetailed(n: number) { return { result: ok(n + this.offset), trace: [{ step: 'read-original', status: 'ok' as const }], plan: null }; } };
  const mutation = bindMutation({ workflow: workflow('decision', (n: number) => ok(n * 2)), operation: 'save', save: async (n: number) => ok(n + 1) });
  const command = process<number>().effect('read', loader).commit(mutation);
  loader.runDetailed = async () => ({ result: ok(1000), trace: [], plan: null });
  mutation.runDetailed = async () => ({ result: ok(10000), trace: [], plan: null });
  const report = await command.runDetailed(1);
  assert.deepEqual(report.result, ok(7));
  assert.deepEqual(report.trace.map(row => row.step), ['read-original', 'read', 'decision', 'save']);
});
test('business default and selected-value detail paths share the original loader and definition', async () => {
  const loader = { offset: 2, async runDetailed(n: number) { return { result: ok(n + this.offset), trace: [{ step: 'read-original', status: 'ok' as const }], plan: null }; } };
  const definition = { name: 'counter', load: loader, save: async (n: number) => ok(n * 2), operations: { go: [(n: number) => ok(n + 1)] as const } };
  const commands = business(definition);
  loader.runDetailed = async () => ({ result: ok(1000), trace: [], plan: null });
  definition.name = 'replaced'; definition.save = async n => ok(n + 100);
  definition.operations.go = [(n: number) => ok(n + 1000)];
  assert.deepEqual(await commands.go(1), ok(8));
  const report = await commands.go.runDetailed(1, { input: value => typeof value, result: value => value.ok });
  assert.deepEqual(report.result, ok(8));
  assert(report.trace.some(row => row.step === 'read-original'));
  assert.equal(report.trace.at(-1)?.step, 'counter.go');
  assert.equal(report.observationErrors.length, 0);
});
