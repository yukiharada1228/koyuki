import test from 'node:test';
import assert from 'node:assert/strict';
import { process, workflow, bindMutation, ok, err, type Result, type ActionReport, type ObservationReport } from './framework/index.js';
const capture = { input: (value: unknown) => value, result: (result: Result<unknown, unknown>) => result.ok ? result.value : result.error };
test('Process captures effects, each through rule and the final commit boundary once', async () => {
  const calls: string[] = [];
  const pure = workflow('validate', (n: number) => { calls.push('validate'); return ok(n + 1); }).then('evolve', n => { calls.push('evolve'); return ok(n * 2); });
  const flow = process<number>()
    .effect('load', async n => { calls.push('load'); return ok(n + 1); })
    .through(pure)
    .commit(bindMutation({ operation: 'save', workflow: workflow('final', (n: number) => ok(n)), save: async n => { calls.push('save'); return ok(n); } }));
  const report = await flow.runDetailed(1, capture);
  assert.deepEqual(report.result, ok(6)); assert.deepEqual(calls, ['load', 'validate', 'evolve', 'save']);
  assert.deepEqual(report.observations.map(row => [row.step, row.input, row.result]), [['load', 1, 2], ['validate', 2, 3], ['evolve', 3, 6], ['commit', 6, 6]]);
  assert.deepEqual(report.observationErrors, []);
  assert.deepEqual(report.trace.map(row => row.step), ['load', 'validate', 'evolve', 'final', 'save']);
  assert(report.plan !== null); assert(Object.isFrozen(report.observations));
});
test('capture defects at IO, pure rules and commit cannot prevent successful writes', async () => {
  let writes = 0, saves = 0;
  const flow = process<number>().effect('write', async n => { writes++; return ok(n); })
    .through(workflow('pure', (n: number) => ok(n + 1)))
    .commit({ runDetailed: async (n: number) => { saves++; return { result: ok(n), trace: [], plan: 'saved' }; } });
  const report = await flow.runDetailed(2, {
    input: (value, step) => { if (step === 'write') throw new Error('input capture'); return value; },
    result: (_result, step) => { if (step === 'pure') throw new Error('result capture'); return { [Symbol('lost')]: true }; },
  });
  assert.deepEqual(report.result, ok(3)); assert.equal(report.plan, 'saved'); assert.equal(writes, 1); assert.equal(saves, 1);
  assert.deepEqual(report.observations, []);
  assert.deepEqual(report.observationErrors, [
    { step: 'write', phase: 'input', kind: 'CaptureFailed' },
    { step: 'pure', phase: 'result', kind: 'CaptureFailed' },
    { step: 'commit', phase: 'result', kind: 'CaptureFailed' },
  ]);
});
test('failed Result is captured and every later rule, effect and commit is skipped', async () => {
  const failure = { kind: 'Denied' } as const; let later = 0;
  const flow = process<number>().effect('load', async n => ok(n))
    .through(workflow('validate', (_: number): Result<number, typeof failure> => err(failure)).then('later-rule', n => { later++; return ok(n); }))
    .effect('later-effect', async n => { later++; return ok(n); })
    .commit({ runDetailed: async (n: number) => { later++; return { result: ok(n), trace: [], plan: null }; } });
  const report = await flow.runDetailed(1, capture);
  assert(!report.result.ok); assert.equal(report.result.error, failure); assert.equal(report.plan, null); assert.equal(later, 0);
  assert.deepEqual(report.observations.map(row => row.step), ['load', 'validate']);
  assert.deepEqual(report.observations[1]?.result, failure);
});
test('capture visits only the selected branch rules and does not invent a predicate value', async () => {
  const flow = process<number>().through(workflow('start', (n: number) => ok(n)).branch('select', n => n > 0, {
    yes: workflow('positive', (n: number) => ok(n + 1)), no: workflow('negative', (n: number) => ok(n - 1)),
  }));
  const yes = await flow.runDetailed(1, capture), no = await flow.runDetailed(-1, capture);
  assert.deepEqual(yes.observations.map(row => row.step), ['start', 'positive']);
  assert.deepEqual(no.observations.map(row => row.step), ['start', 'negative']);
  assert.deepEqual(yes.trace.map(row => row.step), ['start', 'select:yes', 'positive']);
});
test('selection precedes copying; opaque domain values retain identity through IO and save', async () => {
  let reads = 0, writes = 0;
  const proof = Symbol('domain proof');
  class Domain { #value = 4; readonly [proof] = true; value() { return this.#value; } }
  const domain = new Domain();
  Object.defineProperty(domain, 'secret', { enumerable: true, get() { reads++; throw new Error('secret'); } });
  const flow = process<Domain>().effect('load', async value => { assert.equal(value, domain); return ok(value); })
    .commit({ runDetailed: async (value: Domain) => { assert.equal(value, domain); assert(value[proof]); writes++; return { result: ok(value), trace: [], plan: null }; } });
  const report = await flow.runDetailed(domain, { input: value => (value as Domain).value(), result: result => result.ok ? (result.value as Domain).value() : null });
  assert(report.result.ok); assert.equal(report.result.value, domain); assert.equal(reads, 0); assert.equal(writes, 1);
  assert.deepEqual(report.observations.map(row => [row.input, row.result]), [[4, 4], [4, 4]]);
});
test('input capture is detached before mutating IO and selected results stay detached afterward', async () => {
  const input = { visible: { amount: 1 }, secret: 'never selected' };
  const flow = process<typeof input>().effect('mutate', async value => { value.visible.amount = 9; return ok(value); });
  const report = await flow.runDetailed(input, { input: value => (value as typeof input).visible, result: result => result.ok ? (result.value as typeof input).visible : null });
  input.visible.amount = 99;
  assert.deepEqual(report.observations, [{ step: 'mutate', input: { amount: 1 }, result: { amount: 9 } }]);
});
test('nested detailed commands capture their boundary and preserve nested trace, not hidden values', async () => {
  class Command {
    #calls = 0;
    async runDetailed(n: number): Promise<ActionReport<number, never>> {
      this.#calls++; return { result: ok(n + this.#calls), trace: [{ step: 'inside', status: 'ok' }], plan: 'private-plan' };
    }
    get calls() { return this.#calls; }
  }
  const command = new Command(), flow = process<number>().effect('nested', command);
  const detached = flow.runDetailed;
  const report = await detached(1, capture);
  assert.deepEqual(report.result, ok(2)); assert.equal(command.calls, 1); assert.equal(report.plan, null);
  assert.deepEqual(report.trace.map(row => row.step), ['inside', 'nested']);
  assert.deepEqual(report.observations.map(row => row.step), ['nested']);
});
test('throw and rejection remain defects even if input capture also fails', async () => {
  const defect = new Error('defect'); let calls = 0;
  const flow = process<number>().effect('broken', async (_: number): Promise<Result<number, never>> => { calls++; throw defect; });
  await assert.rejects(flow.runDetailed(1, { input: () => { throw new Error('capture'); }, result: () => null }), error => error === defect);
  assert.equal(calls, 1);
});
test('concurrent Process captures are isolated when completion order reverses', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: number[] = [];
  const flow = process<number>().effect('read', async n => { seen.push(n); if (n === 1) await gate; return ok(n + 1); })
    .through(workflow('double', (n: number) => ok(n * 2)));
  const first = flow.runDetailed(1, capture), second = await flow.runDetailed(2, capture);
  release(); const completed = await first;
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(completed.observations.map(row => [row.input, row.result]), [[1, 2], [2, 4]]);
  assert.deepEqual(second.observations.map(row => [row.input, row.result]), [[2, 3], [3, 6]]);
  assert.deepEqual(completed.observationErrors, []); assert.deepEqual(second.observationErrors, []);
});

test('empty Process records no synthetic stage and the ordinary report shape stays unchanged', async () => {
  const flow = process<number>();
  const report = await flow.runDetailed(1, { input: () => { throw new Error('must not select'); }, result: () => { throw new Error('must not select'); } });
  assert.deepEqual(report, { result: ok(1), trace: [], plan: null, observations: [], observationErrors: [] });
  assert.deepEqual(await flow.runDetailed(1), { result: ok(1), trace: [], plan: null });
});

// Input/result/capture types remain independent; ordinary ActionReport extraction stays exact.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts() {
  const flow = process<{ id: number }>().effect('read', async value => ok(value.id));
  const output: Equal<Awaited<ReturnType<typeof flow.runDetailed>>, ActionReport<number, never>> = true;
  const report = flow.runDetailed({ id: 1 }, { input: () => ({ chosen: true }), result: () => 'selected' });
  const selected: Equal<Awaited<typeof report>, ActionReport<number, never> & ObservationReport<{ chosen: boolean }, string>> = true;
  const committed = flow.commit({ runDetailed: async (n: number) => ({ result: ok(String(n)), trace: [], plan: null }) });
  const committedReport = committed.runDetailed({ id: 1 }, { input: () => 1, result: () => true });
  const saved: Equal<Awaited<typeof committedReport>, ActionReport<string, never> & ObservationReport<number, boolean>> = true;
  // @ts-expect-error observation does not widen the required request
  void flow.runDetailed({}, capture);
  // @ts-expect-error observation does not allow an incompatible final consumer
  flow.commit({ runDetailed: async (_: string) => ({ result: ok(''), trace: [], plan: null }) });
  void output; void selected; void saved;
}
void contracts;
