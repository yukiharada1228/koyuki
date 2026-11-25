import test from 'node:test';
import assert from 'node:assert/strict';
import { process, ok, err, defineApplication, operation, describeFlow, type Result, type ActionReport, type ExecutionEvent } from './framework/index.js';
test('effect projection constructs the next context without manual Result plumbing or cloning domain values', async () => {
  class Row { #value = 7; read() { return this.#value; } }
  const row = new Row(), proof = Symbol('proof'), input = { id: 'row', proof }; let reads = 0, projects = 0;
  const flow = process<typeof input>()
    .effect('read', async context => { assert.equal(context, input); reads++; return ok(row); }, (context, current) => {
      projects++; return { input: context, current };
    })
    .effect('use-context', async context => { assert.equal(context.current, row); assert.equal(context.input, input); return ok(context); });
  assert.deepEqual([reads, projects], [0, 0]);
  const report = await flow.runDetailed(input); assert(report.result.ok);
  assert.equal(report.result.value.current.read(), 7); assert.equal(report.result.value.input.proof, proof);
  assert.deepEqual([reads, projects], [1, 1]); assert.equal(report.plan, null);
  assert.deepEqual(report.trace.map(entry => entry.step), ['read', 'use-context']);
});
test('a failed effect returns the original failure and skips projection and all later work', async () => {
  const failure = err('Unavailable' as const); let reads = 0, projects = 0, later = 0;
  const flow = process<number>().effect('read', async (): Promise<Result<string, 'Unavailable'>> => { reads++; return failure; }, (before, value) => { projects++; return { before, value }; })
    .effect('later', async value => { later++; return ok(value); });
  const report = await flow.runDetailed(1);
  assert.equal(report.result, failure); assert.deepEqual([reads, projects, later], [1, 0, 0]);
  assert.deepEqual(report.trace, [{ step: 'read', status: 'error' }]);
});
test('prior failure and IO rejection never invoke the projector', async () => {
  let reads = 0, projects = 0; const defect = Error('port');
  const stopped = process<number>().effect('first', async (): Promise<Result<number, 'Denied'>> => err('Denied'))
    .effect('read', async n => { reads++; return ok(n); }, (before, value) => { projects++; return { before, value }; });
  assert.deepEqual(await stopped.run(1), err('Denied')); assert.deepEqual([reads, projects], [0, 0]);
  const broken = process<number>().effect('read', async (): Promise<Result<number, never>> => { reads++; throw defect; }, (before, value) => { projects++; return { before, value }; });
  await assert.rejects(broken.run(1), cause => cause === defect); assert.deepEqual([reads, projects], [1, 0]);
});
test('projection exceptions preserve the original defect and do not repeat a successful IO', async () => {
  const defect = Error('projection'); let reads = 0, later = 0;
  const flow = process<number>().effect('read', async n => { reads++; return ok(n); }, (): number => { throw defect; })
    .effect('later', async n => { later++; return ok(n); });
  await assert.rejects(flow.run(1), cause => cause === defect); assert.deepEqual([reads, later], [1, 0]);
});
test('selected capture observes the complete projected stage and remains fail-soft', async () => {
  let reads = 0, projects = 0;
  const flow = process<number>().effect('read', async n => { reads++; return ok(n + 1); }, (before, value) => { projects++; return { before, value }; });
  const captured = await flow.runDetailed(1, { input: value => value, result: result => result.ok ? result.value : null });
  assert.deepEqual(captured.observations.map(row => [row.step, row.input, row.result]), [['read', 1, { before: 1, value: 2 }]]);
  assert.deepEqual([reads, projects], [1, 1]);
  const brokenCapture = await flow.runDetailed(3, { input: () => { throw Error('capture'); }, result: () => null });
  assert.deepEqual(brokenCapture.result, ok({ before: 3, value: 4 })); assert.deepEqual([reads, projects], [2, 2]);
  assert.equal(brokenCapture.observationErrors.length, 1);
});
test('detailed loaders retain their receiver and inner trace while projecting only successful output', async () => {
  class Loader {
    #calls = 0;
    async runDetailed(n: number): Promise<ActionReport<string, never>> { this.#calls++; return { result: ok(`${n}/${this.#calls}`), trace: [{ step: 'inside', status: 'ok' }], plan: 'inner-plan' }; }
  }
  const loader = new Loader(), flow = process<number>().effect('read', loader, (input, value) => ({ input, value }));
  const report = await flow.runDetailed(2); assert.deepEqual(report.result, ok({ input: 2, value: '2/1' }));
  assert.deepEqual(report.trace.map(row => row.step), ['inside', 'read']); assert.equal(report.plan, null);
});
test('a projector defect closes the outer live span after the inner IO succeeds', async () => {
  let reads = 0;
  const loader = process<number>().effect('inside', async n => { reads++; return ok(n + 1); });
  const flow = process<number>().effect('read', loader, (): number => { throw Error('SECRET_PROJECTION'); });
  const app = defineApplication({ initial: () => 0, operations: { go: operation(flow, (_: number, n) => n) }, view: state => state.kind });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  const result = await session.dispatch({ type: 'go', input: 1 }); assert(result.ok && result.value.state.kind === 'crashed');
  const complete = events.filter(event => event.kind === 'span-completed');
  assert.equal(complete.find(event => event.step === 'inside')?.status, 'ok');
  assert.equal(complete.find(event => event.step === 'read')?.status, 'defect'); assert.equal(reads, 1);
  assert(!JSON.stringify(events).includes('SECRET_PROJECTION'));
});
test('concurrent runs keep the matching context while projections may replace rather than merge it', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const flow = process<{ id: number; discard: string }>().effect('read', async ({ id }) => { if (id === 1) await gate; return ok(id * 10); }, (context, value) => ({ selected: context.id + value }));
  const slow = flow.run({ id: 1, discard: 'a' }); assert.deepEqual(await flow.run({ id: 2, discard: 'b' }), ok({ selected: 22 }));
  release(); assert.deepEqual(await slow, ok({ selected: 11 }));
});
test('the existing two-argument effect preserves result identity and projection stays inside its declared stage', async () => {
  const success = ok(2); const existing = process<number>().effect('read', async () => success);
  assert.equal(await existing.run(1), success);
  const projected = process<number>().effect('read', async n => ok(n), () => null);
  assert.deepEqual(await projected.run(1), ok(null));
  assert.deepEqual(describeFlow(projected).nodes.map(node => node.name), ['read']);
});
test('explicit field replacement infers the new type instead of an impossible record intersection', async () => {
  const flow = process<{ current: string; id: number }>().effect('read', async input => ok(input.id), (context, current) => ({ ...context, current }));
  const exact: Promise<Result<{ current: number; id: number }, never>> = flow.run({ current: 'unvalidated', id: 2 });
  assert.deepEqual(await exact, ok({ current: 2, id: 2 }));
  const after = flow.effect('use-number', async context => ok(context.current.toFixed(0)));
  assert.deepEqual(await after.run({ current: 'old', id: 3 }), ok('3'));
});
function contracts() {
  const flow = process<{ id: string }>().effect('read', async (): Promise<Result<number, 'Offline'>> => ok(3), (input, value) => ({ input, value }));
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  const exact: Equal<Awaited<ReturnType<typeof flow.run>>, Result<{ input: { id: string }; value: number }, 'Offline'>> = true;
  // @ts-expect-error the projector cannot assume an incompatible effect success type
  process<number>().effect('read', async n => ok(String(n)), (_context, value: number) => value);
  // @ts-expect-error the projector must accept every possible prior context
  process<string>().effect('read', async n => ok(n.length), (context: 'only', value) => ({ context, value }));
  // @ts-expect-error projected values do not invent fields from the previous context
  flow.effect('later', async context => ok(context.id));
  // @ts-expect-error the original run input is retained
  flow.run({ id: 1 });
  void exact;
}
void contracts;
