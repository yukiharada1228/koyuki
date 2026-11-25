import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, process, bindMutation, defineAction, defineCommand, defineTransition, transition, business, withReplay, operation, describeFlow, flowMermaid, ok, type FlowGraph, type Trace, type Result, type Execution } from './framework/index.js';

test('static command description does not run load, rules or save; reports match without rerunning', async () => {
  let loads = 0, rules = 0, saves = 0;
  const flow = workflow('check', (n: number) => { rules++; return ok(n); }).then('evolve', n => ok(n + 1));
  const command = defineCommand({ operation: 'save', loadName: 'load', load: async (n: number) => { loads++; return ok(n); }, decide: flow, save: async (n: number) => { saves++; return ok(n); } });
  const before: FlowGraph = describeFlow(command);
  assert.deepEqual(before.nodes.map(node => node.name), ['load', 'check', 'evolve', 'save']);
  assert.deepEqual(before.nodes.map(node => node.role), ['effect', 'rule', 'rule', 'save']);
  assert.deepEqual(describeFlow(command.run), before);
  assert.deepEqual(describeFlow(command.runDetailed), before);
  assert.equal(before.edges.length, 3); assert.deepEqual([loads, rules, saves], [0, 0, 0]);
  assert(Object.isFrozen(before) && Object.isFrozen(before.nodes) && Object.isFrozen(before.nodes[0]) && Object.isFrozen(before.edges[0]));
  const report = await command.runDetailed(1);
  const observed = describeFlow(command, report.trace);
  assert(observed.nodes.every(node => node.match === 'ok')); assert.deepEqual([loads, rules, saves], [1, 1, 1]);
  assert.deepEqual(describeFlow(command), before);
  const bound = operation(command, (_: number, n) => n);
  assert.deepEqual(describeFlow(bound), before);
});
test('transition records the declared validate/require/evolve roles', () => {
  let calls = 0;
  const definition = defineTransition({ validate: (n: number) => { calls++; return ok(n); }, require: [(n: number) => ok(n)], evolve: (n: number) => ok(n + 1) });
  const graph = describeFlow(transition(definition));
  assert.deepEqual(graph.nodes.map(node => node.role), ['validate', 'require', 'evolve']);
  assert.deepEqual(graph.nodes.map(node => node.name), ['validate', 'require:1', 'evolve']); assert.equal(calls, 0);
});
test('branch diagrams include both declared paths without invoking predicates; only selected names match', () => {
  let predicates = 0, yes = 0, no = 0;
  const flow = workflow('input', (n: number) => ok(n)).branch('route', n => { predicates++; return n > 0; }, {
    yes: workflow('positive', (n: number) => { yes++; return ok(n); }), no: workflow('negative', (n: number) => { no++; return ok(n); }),
  });
  const graph = describeFlow(flow);
  assert.deepEqual([predicates, yes, no], [0, 0, 0]);
  assert.deepEqual(graph.edges.filter(edge => edge.choice).map(edge => edge.choice), ['yes', 'no']);
  assert.equal(graph.nodes.filter(node => node.kind === 'join').length, 1);
  const report = flow.inspect(-1), matched = describeFlow(flow, report.trace);
  assert.equal(matched.nodes.find(node => node.name === 'positive')?.match, 'none');
  assert.equal(matched.nodes.find(node => node.name === 'negative')?.match, 'ok');
  assert.deepEqual([predicates, yes, no], [1, 0, 1]);
});
test('duplicate names stay ambiguous and unknown trace rows are retained as metadata only', () => {
  const flow = workflow('input', (n: number) => ok(n)).branch('route', n => n > 0, { yes: workflow('same', (n: number) => ok(n)), no: workflow('same', (n: number) => ok(n)) });
  const trace: readonly Trace[] = [{ step: 'route:yes', status: 'ok' }, { step: 'same', status: 'ok' }, { step: 'outside', status: 'error' }];
  const graph = describeFlow(flow, trace);
  assert(graph.nodes.filter(node => node.name === 'same').every(node => node.match === 'ambiguous'));
  assert.deepEqual(graph.unmatchedTrace, [{ step: 'outside', status: 'error' }]);
  assert(flowMermaid(flow, trace).includes('ambiguous'));
});
test('Mermaid text encodes syntax characters and newlines instead of adding directives', () => {
  const name = '\"]\nclick evil \"https://example.com\"\n%%{init: {}}\n```';
  const output = flowMermaid(workflow(name, (n: number) => ok(n)));
  assert.equal(output.split('\n').length, 2); assert(output.includes('#34;') && output.includes('#10;') && output.includes('#96;'));
  assert(!output.includes('%%{')); assert(output.startsWith('flowchart TD\n  n0['));
});
test('unknown host objects remain unknown without property reads or execution', () => {
  const host = new Proxy({}, { get() { assert.fail('host property read'); } });
  const graph = describeFlow(host);
  assert.deepEqual(graph.nodes.map(node => [node.name, node.role]), [['unknown', 'unknown']]);
  assert(flowMermaid(host).includes('unknown'));
});
test('Process IO and nested detailed loaders are described without calling them', () => {
  let calls = 0;
  const loader = process<number>().effect('lookup', async n => { calls++; return ok(n); });
  const mutation = bindMutation({ workflow: workflow('check', (n: number) => ok(n)), operation: 'save', save: async (n: number) => { calls++; return ok(n); } });
  const action = defineAction({ loadName: 'load', load: loader, mutation });
  assert.deepEqual(describeFlow(action).nodes.map(node => node.name), ['lookup', 'load', 'check', 'save']);
  const command = process<number>().effect('read', loader).through(workflow('rule', (n: number) => ok(n))).commit(mutation);
  assert.deepEqual(describeFlow(command).nodes.map(node => node.name), ['lookup', 'read', 'rule', 'check', 'save']); assert.equal(calls, 0);
});
test('opaque render and commit implementations are not inferred or executed', () => {
  let calls = 0;
  const mutation = bindMutation({ workflow: workflow('rule', (n: number) => ok(n)), operation: 'save', save: async (n: number) => ok(n), render: () => { calls++; throw Error('render'); } });
  assert(describeFlow(mutation).nodes.some(node => node.role === 'unknown'));
  const opaque = process<number>().commit({ runDetailed: async () => { calls++; return { result: ok(1), trace: [], plan: null }; } });
  assert.deepEqual(describeFlow(opaque).nodes.map(node => node.role), ['unknown']); assert.equal(calls, 0);
});
test('business and replay composition metadata does not invoke lookups or inspect function bodies', () => {
  let calls = 0;
  const commands = business({ name: 'counter', load: async (n: number) => { calls++; return ok(n); }, save: async (n: number) => { calls++; return ok(n); }, operations: { go: [(n: number) => { calls++; return ok(n + 1); }] } });
  assert.deepEqual(describeFlow(commands.go).nodes.map(node => node.name), ['counter.go:load', 'run:1', 'counter.go']);
  const command = { async run(n: number): Promise<Result<Execution<number>, never>> { calls++; return ok({ kind: 'committed', value: n }); } };
  const replay = withReplay(command, { lookup: async () => { calls++; return ok({ kind: 'missing' as const }); }, resolveAfter: () => { calls++; return false; } });
  const graph = describeFlow(replay);
  assert(graph.nodes.some(node => node.kind === 'branch' && node.name === 'replay.cached'));
  assert(graph.nodes.some(node => node.role === 'unknown')); assert.equal(calls, 0);
});


test('trace overlay reads only primitive data fields and rejects invalid statuses without calling getters', () => {
  const flow = workflow('rule', (n: number) => ok(n));
  const row = { step: 'rule', status: 'ok' as const, get payload(): never { throw Error('secret getter'); } };
  assert.equal(describeFlow(flow, [row]).nodes[0]?.match, 'ok');
  const accessor = { get step(): never { throw Error('step getter called'); }, status: 'ok' as const };
  assert.throws(() => describeFlow(flow, [accessor]), { message: 'Invalid flow trace' });
  const invalid = JSON.parse('[{"step":"rule","status":"invented"}]') as Trace[];
  assert.throws(() => describeFlow(flow, invalid), { message: 'Invalid flow trace' });
});


test('long declarations can be described iteratively without running their rules', () => {
  let calls = 0;
  let flow = workflow('first', (n: number) => { calls++; return ok(n); });
  for (let index = 0; index < 1000; index++) flow = flow.then(`stage-${index}`, n => { calls++; return ok(n); });
  const graph = describeFlow(flow);
  assert.equal(graph.nodes.length, 1001); assert.equal(graph.edges.length, 1000); assert.equal(calls, 0);
  assert.equal(graph.nodes.at(-1)?.name, 'stage-999');
});
