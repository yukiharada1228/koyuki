import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operation, operations, business, defineUseCase, defineAction, bindMutation, workflow, process, step, ok, err, withReplay, replayOperation, replayOperations, type ExecutionEvent, type Result, type ActionReport, type Execution } from './framework/index.js';

test('Application correlates detailed IO, rules, save and completion without collecting values', async () => {
  const calls: string[] = [], events: ExecutionEvent[] = [];
  const load = process<{ n: number; token: string }>().effect('lookup', async input => { calls.push('load'); return ok(input.n); });
  const command = defineUseCase({ operation: 'save', load,
    transition: { validate: step('validate', (n: number) => { calls.push('validate'); return n < 0 ? err('SECRET_ERROR' as const) : ok(n); }), require: [] as const, evolve: step('increment', (n: number) => ok(n + 1)) },
    save: async n => { calls.push('save'); return ok(n); },
  });
  const app = defineApplication({ initial: () => 0, operations: { apply: operation(command, (_: number, n) => n) }, view: state => state.kind });
  const session = await app.start({ sessionId: 'host-session', clock: () => calls.length, observeExecution: event => { events.push(event); } });
  const accepted = await session.dispatch({ type: 'apply', input: { n: 2, token: 'SECRET_TOKEN' } }); assert(accepted.ok);
  assert.equal(accepted.value.state.data, 3);
  assert.deepEqual(calls, ['load', 'validate', 'save']);
  assert.deepEqual(events.map(event => event.kind), ['queued', 'started', 'step', 'step', 'step', 'step', 'step', 'completed']);
  assert(events.every(event => event.executionId === 'host-session/1' && event.operation === 'apply' && Object.isFrozen(event)));
  assert.deepEqual(events.filter(event => event.kind === 'step').map(event => event.step), ['lookup', 'save:load', 'validate', 'increment', 'save']);
  assert(events.filter(event => event.kind === 'step').every(event => event.timing === 'reported-after-run'));
  const failed = await session.dispatch({ type: 'apply', input: { n: -1, token: 'SECRET_TOKEN' } }); assert(failed.ok && failed.value.state.kind === 'failed');
  assert.equal(events.at(-1)?.kind, 'completed');
  assert.deepEqual(events.filter(event => event.kind === 'completed').map(event => event.status), ['ok', 'error']);
  assert(!JSON.stringify(events).includes('SECRET'));
});

test('without execution observers the original run route remains selected; detailed methods keep their receiver', async () => {
  const command = {
    runs: 0, details: 0, value: 7,
    async run(_input: number) { this.runs++; return ok(this.value); },
    async runDetailed(_input: number) { this.details++; return { result: ok(this.value), trace: [{ step: 'work', status: 'ok' as const }], plan: null }; },
  };
  const app = defineApplication({ initial: () => 0, operations: operations({ go: command }, (_: number, value: number) => value), view: state => state.data });
  const plain = await app.start(); assert((await plain.dispatch({ type: 'go', input: 1 })).ok);
  assert.deepEqual([command.runs, command.details], [1, 0]);
  const observed = await app.start(), events: ExecutionEvent[] = [];
  const stop = observed.subscribeExecution(event => { events.push(event); });
  assert((await observed.dispatch({ type: 'go', input: 1 })).ok);
  assert.deepEqual([command.runs, command.details], [1, 1]); assert.equal(observed.snapshot().state.data, 7);
  stop(); const count = events.length;
  assert((await observed.dispatch({ type: 'go', input: 1 })).ok);
  assert.equal(events.length, count); assert.deepEqual([command.runs, command.details], [2, 1]);
});

test('receipt replay reports only executed receipt stages and does not invent or repeat business work', async () => {
  let saved: number | undefined, loads = 0, writes = 0;
  const command = defineUseCase({ operation: 'save', load: async (n: number) => { loads++; return ok(n); },
    transition: { validate: step('validate', (n: number) => ok(n)), require: [] as const, evolve: step('double', (n: number) => ok(n * 2)) },
    save: async (n): Promise<Result<Execution<number>, never>> => { writes++; saved = n; return ok({ kind: 'committed', value: n }); },
  });
  const replay = withReplay(command, { lookup: async () => ok(saved === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, value: saved }), resolveAfter: () => false });
  const app = defineApplication({ initial: () => 0, operations: { go: replayOperation(replay, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ sessionId: 'replay', observeExecution: event => { events.push(event); } });
  assert((await session.dispatch({ type: 'go', input: 3 })).ok);
  assert((await session.dispatch({ type: 'go', input: 3 })).ok);
  assert.deepEqual([loads, writes], [1, 1]); assert.equal(session.snapshot().state.data, 6);
  const first = events.filter(event => event.executionId === 'replay/1' && event.kind === 'step');
  const second = events.filter(event => event.executionId === 'replay/2' && event.kind === 'step');
  assert(first.some(event => event.kind === 'step' && event.step === 'double'));
  assert.deepEqual(second.map(event => event.kind === 'step' ? event.step : ''), ['replay.snapshot', 'replay.lookup']);
});

test('queued stale requests have a distinct ID and finish rejected without starting IO', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command = { async run(n: number) { calls++; await gate; return ok(n); } };
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.kind });
  const events: ExecutionEvent[] = [], session = await app.start({ sessionId: 'queue', observeExecution: event => { events.push(event); } });
  const first = session.dispatch({ type: 'go', input: 1 }, 0), second = session.dispatch({ type: 'go', input: 2 }, 0);
  release(); assert((await first).ok); assert.deepEqual(await second, err({ kind: 'StaleRevision' }));
  assert.equal(calls, 1);
  assert.deepEqual(events.filter(event => event.executionId === 'queue/2').map(event => event.kind === 'completed' ? event.status : event.kind), ['queued', 'rejected']);
});

test('observer exceptions, rejections and broken clocks do not change accepted results', async () => {
  const command = { async run(n: number) { return ok(n); } };
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ clock: () => { throw Error('clock'); }, observeExecution: () => { throw Error('observer'); } });
  session.subscribeExecution(async () => { throw Error('async observer'); });
  session.subscribeExecution(event => { events.push(event); });
  const result = await session.dispatch({ type: 'go', input: 5 }); assert(result.ok && result.value.state.data === 5);
  assert.deepEqual(events.map(event => event.kind), ['queued', 'started', 'completed']);
  assert(events.every(event => event.elapsedMs === 0));
});

test('unexpected IO and projection defects finish as defect without exposing error messages', async () => {
  for (const phase of ['run', 'projection'] as const) {
    const command = { async run(n: number) { if (phase === 'run') throw Error('SECRET'); return ok(n); } };
    const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => { if (phase === 'projection') throw Error('SECRET'); return n; }) }, view: state => state.kind });
    const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => { events.push(event); } });
    const result = await session.dispatch({ type: 'go', input: 1 }); assert(result.ok && result.value.state.kind === 'crashed');
    const completed = events.at(-1); assert(completed?.kind === 'completed' && completed.status === 'defect');
    assert(!JSON.stringify(events).includes('SECRET'));
  }
});

test('diagnostic getter failures cannot replace a successful operation result', async () => {
  const command = { async run(n: number) { return ok(n); }, async runDetailed(n: number): Promise<ActionReport<number, never>> { return { result: ok(n), get trace(): never { throw Error('trace'); }, plan: null }; } };
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const session = await app.start({ observeExecution: () => {} });
  const result = await session.dispatch({ type: 'go', input: 3 }); assert(result.ok && result.value.state.data === 3);
});

test('parallel sessions keep IDs, completed results and selected steps separate', async () => {
  const release = new Map<number, () => void>();
  const command = {
    async run(n: number) { return ok(n); },
    async runDetailed(n: number) { await new Promise<void>(resolve => { release.set(n, resolve); }); return { result: ok(n), trace: [{ step: `stage-${n}`, status: 'ok' as const }], plan: null }; },
  };
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const a: ExecutionEvent[] = [], b: ExecutionEvent[] = [];
  const first = await app.start({ sessionId: 'first', observeExecution: event => { a.push(event); } }), second = await app.start({ sessionId: 'second', observeExecution: event => { b.push(event); } });
  const one = first.dispatch({ type: 'go', input: 1 }), two = second.dispatch({ type: 'go', input: 2 });
  await Promise.resolve(); assert.equal(release.size, 2);
  release.get(2)!(); assert((await two).ok); release.get(1)!(); assert((await one).ok);
  assert.equal(first.snapshot().state.data, 1); assert.equal(second.snapshot().state.data, 2);
  assert(a.every(event => event.executionId === 'first/1')); assert(b.every(event => event.executionId === 'second/1'));
  assert.deepEqual(a.filter(event => event.kind === 'step').map(event => event.step), ['stage-1']);
  assert.deepEqual(b.filter(event => event.kind === 'step').map(event => event.step), ['stage-2']);
});

test('queued notifications cannot let a new diagnostic-triggered dispatch overtake accepted work', async () => {
  const calls: number[] = [];
  const command = { async run(n: number) { calls.push(n); return ok(n); } };
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const session = await app.start(); let reentered = false, pending: ReturnType<typeof session.dispatch> | undefined;
  session.subscribeExecution(event => { if (event.kind === 'queued' && !reentered) { reentered = true; pending = session.dispatch({ type: 'go', input: 2 }); } });
  assert((await session.dispatch({ type: 'go', input: 1 })).ok); assert(pending); assert((await pending).ok);
  assert.deepEqual(calls, [1, 2]);
});

test('operation detail capability cannot narrow the accepted command input or widen its output', () => {
  if (false) {
    const command = { async run(input: number) { return ok(input); }, async runDetailed(input: 1) { return { result: ok(input), trace: [], plan: null }; } };
    // @ts-expect-error detailed path must accept every command input
    operation(command, (_state: number, output) => output);
    const wrong = { async run(input: number) { return ok(input); }, async runDetailed(_input: number) { return { result: ok('wrong'), trace: [], plan: null }; } };
    // @ts-expect-error detailed success must preserve the command result contract
    operation(wrong, (_state: number, output) => output);
    // @ts-expect-error table registration also checks the detailed path
    operations({ go: wrong }, (_state: number, output) => output);
    // @ts-expect-error table detail input cannot be narrower than run input
    operations({ go: command }, (_state: number, output) => output);
    const wrongReplay = { async run(n: number): Promise<Result<Execution<number>, never>> { return ok({ kind: 'committed', value: n }); }, async runDetailed(_n: number) { return { result: ok({ kind: 'committed' as const, value: 'wrong' }), trace: [], plan: null }; } };
    // @ts-expect-error replay table detail output must match run output
    replayOperations({ go: wrongReplay }, (_state: number, output) => output);
    // @ts-expect-error raw Application operations cannot bypass the detail contract
    defineApplication({ initial: () => 0, operations: { go: { ...wrong, reduce: (_state: number, value: number) => value } }, view: state => state.data });
  }
});


test('branch observation includes only the selected route and does not reevaluate rules', async () => {
  let positive = 0, negative = 0;
  const rules = workflow('input', (n: number) => ok(n)).branch('direction', n => n >= 0, {
    yes: workflow('positive', (n: number) => { positive++; return ok(n); }),
    no: workflow('negative', (n: number) => { negative++; return ok(n); }),
  });
  const command = defineAction({ loadName: 'load', load: async (n: number) => ok(n), mutation: bindMutation({ operation: 'save', workflow: rules, save: async (n: number) => ok(n) }) });
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  assert((await session.dispatch({ type: 'go', input: 1 })).ok);
  assert.deepEqual([positive, negative], [1, 0]);
  assert.deepEqual(events.filter(event => event.kind === 'step').map(event => event.step), ['load', 'input', 'direction:yes', 'positive', 'save']);
});


test('recommended business callables expose rules through Application without extra IO', async () => {
  let reads = 0, writes = 0, rules = 0;
  const commands = business({ name: 'counter', load: async (n: number) => { reads++; return ok(n); }, save: async (n: number) => { writes++; return ok(n); }, operations: { go: [(n: number) => { rules++; return ok(n + 1); }] } });
  const app = defineApplication({ initial: () => 0, operations: operations(commands, (_: number, n) => n), view: state => state.data });
  const events: ExecutionEvent[] = [], observed = await app.start({ observeExecution: event => events.push(event) }), plain = await app.start();
  const first = await observed.dispatch({ type: 'go', input: 1 }), second = await plain.dispatch({ type: 'go', input: 1 });
  assert(first.ok && second.ok); assert.deepEqual(first.value, second.value);
  assert.deepEqual([reads, rules, writes], [2, 2, 2]);
  assert(events.some(event => event.kind === 'step' && event.step === 'run:1'));
  const finished = events.at(-1); assert(finished?.kind === 'completed' && finished.status === 'ok');
});
