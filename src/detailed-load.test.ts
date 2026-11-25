import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, process, workflow, bindMutation, defineAction, defineCommand, business, defineTarget, defineRequestTarget, defineUseCase, defineUseCaseGroup, step,
  type Result, type ActionReport, type ActionLoad, type Execution, type Receipt } from './framework/index.js';
const trace = (step: string, status: 'ok' | 'error' = 'ok') => ({ step, status });
const load = () => process<number>().effect('read-one', async n => ok(n + 1)).effect('read-two', async n => ok(n + 1));
const decide = workflow('decide', (n: number) => ok(n + 1));
const save = async (n: number) => ok(n);

test('detailed action load includes internal trace once and keeps only final mutation plan', async () => {
  let reads = 0, writes = 0;
  const action = defineAction({ loadName: 'load', load: { runDetailed: async (n: number) => {
    reads++; return { result: ok(n), trace: [trace('read')], plan: { discarded: true } };
  } }, mutation: { runDetailed: async (n: number) => { writes++; return { result: ok(n + 1), trace: [trace('save')], plan: { final: true } }; } } });
  assert.deepEqual(await action.runDetailed(1), { result: ok(2), trace: [trace('read'), trace('load'), trace('save')], plan: { final: true } });
  assert.equal(reads, 1); assert.equal(writes, 1);
});

test('failed detailed load retains its failure trace, clears load plan and skips mutation', async () => {
  const action = defineAction({ loadName: 'load', load: { runDetailed: async (_: number): Promise<ActionReport<number, 'Missing'>> => ({
    result: err('Missing'), trace: [trace('read-one'), trace('read-two', 'error')], plan: { neverSaveThis: true },
  }) }, mutation: { runDetailed: async (n: number) => { assert.fail('must not mutate'); return { result: ok(n), trace: [], plan: null }; } } });
  assert.deepEqual(await action.runDetailed(1), { result: err('Missing'), trace: [trace('read-one'), trace('read-two', 'error'), trace('load', 'error')], plan: null });
});

test('ordinary callable load never implicitly selects its runDetailed property', async () => {
  let calls = 0;
  const callable = Object.assign(async (n: number) => { calls++; return ok(n); }, { runDetailed: async (_: number) => { assert.fail('explicit object required'); return { result: ok(0), trace: [], plan: null }; } });
  const action = defineCommand({ operation: 'save', load: callable, decide, save });
  const report = await action.runDetailed(1);
  assert.deepEqual(report.trace, [trace('save:load'), trace('decide'), trace('save')]); assert.equal(calls, 1);
});

test('detailed load preserves object receiver and propagates defects without retry', async () => {
  const defect = new Error('storage failed');
  class Loader {
    #calls = 0;
    async runDetailed(n: number): Promise<ActionReport<number, never>> {
      this.#calls++; if (n < 0) throw defect;
      return { result: ok(n + this.#calls), trace: [trace('read')], plan: null };
    }
    get calls() { return this.#calls; }
  }
  const loader = new Loader();
  const action = defineCommand({ operation: 'save', load: loader, decide, save });
  assert.deepEqual(await action.run(1), ok(3));
  await assert.rejects(action.runDetailed(-1), cause => cause === defect); assert.equal(loader.calls, 2);
});

test('detailed loaders connect through all transition entry points using the same action runtime', async () => {
  const transition = { validate: step('validate', (n: number) => ok(n)), require: [] as const, evolve: step('evolve', (n: number) => ok(n + 1)) };
  const target = defineTarget({ operation: 'save', load: load(), save }).on(transition);
  const request = defineRequestTarget({ operation: 'save', load: load(), save }).on(transition);
  const useCase = defineUseCase({ operation: 'save', load: load(), save, transition });
  const group = defineUseCaseGroup({ operation: (_name: 'change') => 'save', save });
  const grouped = group.on('change', { load: load(), transition });
  for (const command of [target, request, useCase, grouped]) {
    const report = await command.runDetailed(1); assert.deepEqual(report.result, ok(4));
    assert.deepEqual(report.trace.map(entry => entry.step), ['read-one', 'read-two', 'save:load', 'validate', 'evolve', 'save']);
  }
});

test('business common and operation-specific detailed loads keep types, trace and selected capture', async () => {
  let queries = 0, saves = 0;
  const query = process<number>().effect('query', async n => { queries++; return ok(n + 1); });
  const api = business({ name: 'number', load: query, save: async (n: number) => { saves++; return ok(n); }, operations: {
    change: [(n: number) => ok(n + 1)],
    other: { load: process<string>().effect('length', async text => ok(text.length)), run: [(n: number) => ok(n)] },
  } });
  const report = await api.change.runDetailed(2, { input: (_value, name) => name, result: value => value.ok });
  assert.deepEqual(report.result, ok(4)); assert.deepEqual(report.trace.map(entry => entry.step), ['query', 'number.change:load', 'run:1', 'number.change']);
  assert.deepEqual(report.observations.map(entry => entry.step), ['number.change:load', 'run:1', 'number.change']);
  assert.deepEqual(report.observationErrors, []); assert.equal(queries, 1); assert.equal(saves, 1);
  assert.deepEqual(await api.other('abc'), ok(3));
  const failedCapture = await api.change.runDetailed(2, { input: () => { throw new Error('capture'); }, result: () => null });
  assert.deepEqual(failedCapture.result, ok(4)); assert.equal(queries, 2); assert.equal(saves, 3);
  assert.equal(failedCapture.observationErrors.length, 3); assert.equal(failedCapture.trace[0]?.step, 'query');
});

test('business replay hit skips detailed load; a missing receipt preserves detailed attempt', async () => {
  let reads = 0;
  const make = (found: boolean) => business({ name: 'number',
    load: process<number>().effect('query', async n => { reads++; return ok(n); }),
    save: async (n: number): Promise<Result<Execution<number>, 'Conflict'>> => ok({ kind: 'committed', value: n }),
    operations: { change: [(n: number) => ok(n + 1)] },
    replay: { lookup: (): Result<Receipt<number>, never> => ok(found ? { kind: 'found', value: 9 } : { kind: 'missing' }), resolveAfter: [] },
  });
  const hit = await make(true).change.runDetailed(1); assert.equal(hit.attempt, null); assert.equal(reads, 0);
  const miss = await make(false).change.runDetailed(1); assert.deepEqual(miss.result, ok({ kind: 'committed', value: 2 }));
  assert.deepEqual(miss.attempt?.trace?.map(entry => entry.step), ['query', 'number.change:load', 'run:1', 'number.change']); assert.equal(reads, 1);
});

test('concurrent detailed loads keep each request capture, result and save isolated', async () => {
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const reads: number[] = [], saved: number[] = [];
  const query = process<number>().effect('query', async n => {
    reads.push(n); if (n === 1) await gate;
    return ok(n + 10);
  });
  const api = business({ name: 'concurrent', load: query,
    save: async (n: number) => { saved.push(n); return ok(n); },
    operations: { change: [(n: number) => ok(n + 1)] },
  });
  const capture = { input: (value: unknown) => value, result: (value: Result<unknown, unknown>) => value.ok ? value.value : null };
  const first = api.change.runDetailed(1, capture);
  const second = await api.change.runDetailed(2, capture);
  assert.deepEqual(second.result, ok(13)); assert.deepEqual(saved, [13]);
  releaseFirst(); const completed = await first;
  assert.deepEqual(completed.result, ok(12)); assert.deepEqual(saved, [13, 12]);
  assert.deepEqual(reads, [1, 2]);
  assert.deepEqual(completed.observations.map(row => [row.input, row.result]), [[1, 11], [11, 12], [12, 12]]);
  assert.deepEqual(second.observations.map(row => [row.input, row.result]), [[2, 12], [12, 13], [13, 13]]);
  assert.deepEqual(completed.observationErrors, []); assert.deepEqual(second.observationErrors, []);
  assert.deepEqual(completed.trace.map(row => row.step), ['query', 'concurrent.change:load', 'run:1', 'concurrent.change']);
  assert.deepEqual(second.trace, completed.trace);
});

// Exact inferred public inputs, outputs and error unions, including rejected connections.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts() {
  const loader = { runDetailed: async (_: { id: string }): Promise<ActionReport<number, 'Read'>> => ({ result: ok(1), trace: [], plan: null }) };
  const api = business({ name: 'typed', load: loader,
    save: async (n: string): Promise<Result<string, 'Write'>> => ok(n),
    operations: { change: [(n: number): Result<string, 'Rule'> => ok(String(n))] },
  });
  const input: Equal<Parameters<typeof api.change>[0], { id: string }> = true;
  const result: Equal<Awaited<ReturnType<typeof api.change>>, Result<string, 'Read' | 'Rule' | 'Write'>> = true;
  const action = defineAction({ loadName: 'read', load: loader, mutation: bindMutation({ operation: 'save', workflow: decide, save }) });
  const actionInput: Equal<Parameters<typeof action.run>[0], { id: string }> = true;
  const actionResult: Equal<Awaited<ReturnType<typeof action.run>>, Result<number, 'Read'>> = true;
  // @ts-expect-error the load cannot omit its required request fields
  void api.change({});
  // @ts-expect-error the loaded number is not a string
  defineAction({ loadName: 'read', load: loader, mutation: { runDetailed: async (_: string) => ({ result: ok(1), trace: [], plan: null }) } });
  const narrow = { runDetailed: async (_: 1) => ({ result: ok(1), trace: [], plan: null }) };
  // @ts-expect-error the mutation must accept all numbers, not just the literal one
  defineAction({ loadName: 'read', load: loader, mutation: narrow });
  business({ name: 'bad', load: loader, save, operations: {
    // @ts-expect-error detailed loaders also check the first rule's input
    change: [(n: string) => ok(n.length)],
  } });
  const unionLoad = { runDetailed: async (_: number): Promise<ActionReport<number | string, never>> => ({ result: ok(1), trace: [], plan: null }) };
  // @ts-expect-error the mutation must accept every loaded union member
  defineAction({ loadName: 'read', load: unionLoad, mutation: { runDetailed: async (_: number) => ({ result: ok(1), trace: [], plan: null }) } });
  const replayReport = { runDetailed: async (_: number) => ({ result: ok({ kind: 'committed' as const, value: 1 }), trace: [], attempt: null }) };
  // @ts-expect-error a ReplayReport is not an ActionReport loader
  defineAction({ loadName: 'read', load: replayReport, mutation: { runDetailed: async (_: unknown) => ({ result: ok(1), trace: [], plan: null }) } });
  const dynamic = Math.random() > 0.5 ? async (_: { left: string }) => ok(1)
    : { runDetailed: async (_: { right: number }) => ({ result: ok(1), trace: [], plan: null }) };
  const selected = business({ name: 'dynamic', load: dynamic, save, operations: { change: [(n: number) => ok(n)] } });
  void selected.change({ left: 'a', right: 1 });
  // @ts-expect-error either loader can run, so both request requirements are necessary
  void selected.change({ left: 'a' });
  // @ts-expect-error either loader can run, so both request requirements are necessary
  void selected.change({ right: 1 });
  const selectedAction = defineAction({ loadName: 'read', load: dynamic, mutation: bindMutation({ operation: 'save', workflow: decide, save }) });
  void selectedAction.run({ left: 'a', right: 1 });
  // @ts-expect-error action input also satisfies every possible loader
  void selectedAction.run({ left: 'a' });
  const invalidDynamic = Math.random() > 0.5 ? async (_: number) => ok(1) : { runDetailed: 1 };
  // @ts-expect-error every dynamically selected loader must satisfy its contract
  defineAction({ loadName: 'read', load: invalidDynamic, mutation: bindMutation({ operation: 'save', workflow: decide, save }) });
  const explicitAction = defineAction<number, string, 'Read', boolean, 'Rule'>({
    loadName: 'read', load: { runDetailed: async id => {
      const inputExact: Equal<typeof id, number> = true; void inputExact;
      return { result: ok(id.toFixed()), trace: [], plan: null };
    } }, mutation: { runDetailed: async text => ({ result: ok(text.length > 0), trace: [], plan: null }) },
  });
  const explicitActionResult: Equal<Awaited<ReturnType<typeof explicitAction.run>>, Result<boolean, 'Read' | 'Rule'>> = true;
  const explicitCommand = defineCommand<number, string, 'Read', number, 'Rule', boolean, 'Write'>({
    operation: 'explicit', load: { runDetailed: async id => ({ result: ok(id.toFixed()), trace: [], plan: null }) },
    decide: workflow('length', (text: string): Result<number, 'Rule'> => ok(text.length)),
    save: async length => ok(length > 0),
  });
  const explicitCommandResult: Equal<Awaited<ReturnType<typeof explicitCommand.run>>, Result<boolean, 'Read' | 'Rule' | 'Write'>> = true;
  const selectedLoad: ActionLoad<{ id: string }, number, 'Plain' | 'Detailed'> = Math.random() > 0.5
    ? async request => ok(request.id.length)
    : { runDetailed: async request => ({ result: ok(request.id.length), trace: [], plan: null }) };
  const selectedCommand = defineCommand({ operation: 'selected', load: selectedLoad,
    decide: workflow('rule', (n: number): Result<number, 'Rule'> => ok(n)),
    save: async (n: number): Promise<Result<number, 'Write'>> => ok(n),
  });
  const selectedInput: Equal<Parameters<typeof selectedCommand.run>[0], { id: string }> = true;
  const selectedResult: Equal<Awaited<ReturnType<typeof selectedCommand.run>>, Result<number, 'Plain' | 'Detailed' | 'Rule' | 'Write'>> = true;
  // @ts-expect-error selecting a loader does not make its request optional
  void selectedCommand.run({});
  const stringLoad = { runDetailed: async (_: number): Promise<ActionReport<string, never>> => ({ result: ok('arbitrary'), trace: [], plan: null }) };
  // @ts-expect-error detailed input has not established the literal required by the rule
  defineCommand({ operation: 'bad', load: stringLoad, decide: workflow('literal', (_: 'approved') => ok(1)), save });
  // @ts-expect-error explicit type arguments cannot bypass the rule input contract
  defineCommand<number, string, never, number, never, number, never>({ operation: 'bad-explicit', load: stringLoad, decide: workflow('literal', (_: 'approved') => ok(1)), save });
  void explicitActionResult; void explicitCommandResult; void selectedInput; void selectedResult;
  void input; void result; void actionInput; void actionResult;
}
void contracts;
