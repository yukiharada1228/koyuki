import test from 'node:test';
import assert from 'node:assert/strict';
import { business, defineApplication, operations, operation, defineCommand, workflow, process, bindMutation, withReplay, replayOperation, ok, err, type Execution, type Result, type ExecutionEvent } from './framework/index.js';
type Start = Extract<ExecutionEvent, { kind: 'span-started' }>;
type End = Extract<ExecutionEvent, { kind: 'span-completed' }>;
const starts = (events: readonly ExecutionEvent[]) => events.filter((event): event is Start => event.kind === 'span-started');
const ends = (events: readonly ExecutionEvent[]) => events.filter((event): event is End => event.kind === 'span-completed');
function balanced(events: readonly ExecutionEvent[]) {
  const begin = starts(events), finish = ends(events);
  assert.equal(begin.length, finish.length);
  assert.equal(new Set(begin.map(event => event.spanId)).size, begin.length);
  for (const event of begin) assert.equal(finish.filter(end => end.spanId === event.spanId).length, 1);
}

test('live business span starts while load is pending and measures its duration without repeating IO', async () => {
  let release!: () => void, entered!: () => void, now = 10, reads = 0, rules = 0, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), loading = new Promise<void>(resolve => { entered = resolve; });
  const commands = business({ name: 'counter', load: async (input: { n: number; token: string }) => { reads++; entered(); await gate; return ok(input.n); },
    save: async (n: number) => { writes++; return ok(n); }, operations: { go: [(n: number) => { rules++; return ok(n + 1); }] } });
  const app = defineApplication({ initial: () => 0, operations: operations(commands, (_: number, n) => n), view: state => state.kind });
  const events: ExecutionEvent[] = [], session = await app.start({ sessionId: 'live', clock: () => now, observeExecution: event => events.push(event) });
  const pending = session.dispatch({ type: 'go', input: { n: 2, token: 'SECRET_TOKEN' } });
  await loading;
  assert.equal(starts(events).filter(event => event.step === 'counter.go:load').length, 1);
  assert.equal(ends(events).length, 0); assert.equal(session.snapshot().state.kind, 'running');
  assert.deepEqual([reads, rules, writes], [1, 0, 0]);
  now = 35; release(); const result = await pending; assert(result.ok && result.value.state.data === 3);
  assert.equal(ends(events).find(event => event.step === 'counter.go:load')?.durationMs, 25);
  assert.deepEqual([reads, rules, writes], [1, 1, 1]); balanced(events);
  assert(!JSON.stringify(events).includes('SECRET_TOKEN'));
});
test('nested detailed loader spans retain parent identity and finish before the outer load span', async () => {
  const loader = process<number>().effect('driver-read', async n => ok(n));
  // Use the object contract so the runtime can explicitly follow its detailed capability.
  const actual = defineCommand({ operation: 'save', load: loader, decide: workflow('validate', (n: number) => ok(n)), save: async (n: number) => ok(n) });
  const app = defineApplication({ initial: () => 0, operations: { go: operation(actual, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  assert((await session.dispatch({ type: 'go', input: 4 })).ok);
  const parent = starts(events).find(event => event.step === 'save:load'), child = starts(events).find(event => event.step === 'driver-read');
  assert(parent && child); assert.equal(child.parentSpanId, parent.spanId);
  assert(ends(events).findIndex(event => event.spanId === child.spanId) < ends(events).findIndex(event => event.spanId === parent.spanId));
  balanced(events);
});
test('expected failures and defects close the active rule span without executing later stages or leaking errors', async () => {
  for (const input of [-1, 0]) {
    let saves = 0;
    const command = defineCommand({ operation: 'save', load: async (n: number) => ok(n), decide: workflow('validate', (n: number): Result<number, 'SECRET_ERROR'> => { if (n === 0) throw Error('SECRET_DEFECT'); return n < 0 ? err('SECRET_ERROR') : ok(n); }).then('later', n => ok(n)), save: async (n: number) => { saves++; return ok(n); } });
    const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.kind });
    const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
    const result = await session.dispatch({ type: 'go', input }); assert(result.ok);
    assert.equal(result.value.state.kind, input === 0 ? 'crashed' : 'failed');
    assert.equal(ends(events).find(event => event.step === 'validate')?.status, input === 0 ? 'defect' : 'error');
    assert(!starts(events).some(event => event.step === 'later' || event.step === 'save')); assert.equal(saves, 0);
    balanced(events); assert(!JSON.stringify(events).includes('SECRET'));
  }
});
test('branch scopes own only the selected child and close on predicate or child defects', async () => {
  for (const input of [0, 1]) {
    const flow = workflow('input', (n: number) => ok(n)).branch('route', n => { if (n === 0) throw Error('predicate'); return n > 0; }, {
      yes: workflow('yes', (_n: number): Result<number, never> => { throw Error('child'); }), no: workflow('no', (n: number) => ok(n)),
    });
    const command = defineCommand({ operation: 'save', load: async (n: number) => ok(n), decide: flow, save: async (n: number) => ok(n) });
    const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.kind });
    const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
    assert((await session.dispatch({ type: 'go', input })).ok);
    const parent = starts(events).find(event => event.step === 'route'); assert(parent);
    assert.equal(ends(events).find(event => event.spanId === parent.spanId)?.status, 'defect');
    const child = starts(events).find(event => event.step === 'yes');
    if (input === 1) { assert(child); assert.equal(child.parentSpanId, parent.spanId); } else assert.equal(child, undefined);
    assert(!starts(events).some(event => event.step === 'no')); balanced(events);
  }
});
test('Process commit passes the live observer through the final mutation but runs every function once', async () => {
  let reads = 0, decisions = 0, writes = 0;
  const loader = process<number>().effect('driver', async n => { reads++; return ok(n + 1); });
  const mutation = bindMutation({ workflow: workflow('decision', (n: number) => { decisions++; return ok(n * 2); }), operation: 'save', save: async (n: number) => { writes++; return ok(n + 1); } });
  const command = process<number>().effect('read', loader).through(workflow('double', (n: number) => ok(n * 2))).commit(mutation);
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  const result = await session.dispatch({ type: 'go', input: 2 }); assert(result.ok && result.value.state.data === 13);
  assert.deepEqual([reads, decisions, writes], [1, 1, 1]);
  const commit = starts(events).find(event => event.step === 'commit'); assert(commit);
  for (const name of ['decision', 'save']) assert.equal(starts(events).find(event => event.step === name)?.parentSpanId, commit.spanId);
  balanced(events);
});
test('cached replay emits only snapshot and lookup spans and does not invent a command attempt', async () => {
  let cached: number | undefined, reads = 0, writes = 0;
  const command = defineCommand({ operation: 'save', load: async (n: number) => { reads++; return ok(n); }, decide: workflow('double', (n: number) => ok(n * 2)), save: async (n: number): Promise<Result<Execution<number>, never>> => { writes++; cached = n; return ok({ kind: 'committed', value: n }); } });
  const replay = withReplay(command, { lookup: async () => ok(cached === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, value: cached }), resolveAfter: () => false });
  const app = defineApplication({ initial: () => 0, operations: { go: replayOperation(replay, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ sessionId: 'receipt', observeExecution: event => events.push(event) });
  assert((await session.dispatch({ type: 'go', input: 3 })).ok); assert((await session.dispatch({ type: 'go', input: 3 })).ok);
  assert.deepEqual([reads, writes], [1, 1]);
  const second = events.filter(event => event.executionId === 'receipt/2');
  assert.deepEqual(starts(second).map(event => event.step), ['replay.snapshot', 'replay.lookup:before', 'application.project']);
  balanced(events);
});
test('observer failures and clock failures cannot turn a committed business operation into an error', async () => {
  let writes = 0;
  const commands = business({ name: 'counter', load: async (n: number) => ok(n), save: async (n: number) => { writes++; return ok(n); }, operations: { go: [(n: number) => ok(n)] } });
  const app = defineApplication({ initial: () => 0, operations: operations(commands, (_: number, n) => n), view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ clock: () => { throw Error('clock'); }, observeExecution: () => { throw Error('observer'); } });
  session.subscribeExecution(async () => { throw Error('async observer'); }); session.subscribeExecution(event => events.push(event));
  const result = await session.dispatch({ type: 'go', input: 4 }); assert(result.ok && result.value.state.data === 4); assert.equal(writes, 1);
  assert(ends(events).every(event => event.durationMs === 0)); balanced(events);
});


test('parallel sessions retain separate live span parents when IO completes in reverse order', async () => {
  const release = new Map<number, () => void>(), entered = new Map<number, () => void>();
  const firstEntered = new Promise<void>(resolve => entered.set(1, resolve)), secondEntered = new Promise<void>(resolve => entered.set(2, resolve));
  const loader = process<number>().effect('driver', async n => { entered.get(n)!(); await new Promise<void>(resolve => release.set(n, resolve)); return ok(n); });
  const command = defineCommand({ operation: 'save', load: loader, decide: workflow('rule', (n: number) => ok(n)), save: async (n: number) => ok(n) });
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const a: ExecutionEvent[] = [], b: ExecutionEvent[] = [];
  const first = await app.start({ sessionId: 'first', observeExecution: event => a.push(event) }), second = await app.start({ sessionId: 'second', observeExecution: event => b.push(event) });
  const one = first.dispatch({ type: 'go', input: 1 }), two = second.dispatch({ type: 'go', input: 2 });
  await Promise.all([firstEntered, secondEntered]); release.get(2)!(); assert((await two).ok); release.get(1)!(); assert((await one).ok);
  for (const [prefix, events] of [['first/1', a], ['second/1', b]] as const) {
    assert(starts(events).every(event => event.spanId.startsWith(prefix)));
    assert(starts(events).every(event => event.parentSpanId === null || event.parentSpanId.startsWith(prefix)));
    balanced(events);
  }
});
test('receipt resolution retains the failed save span and does not retry the command', async () => {
  let saved: number | undefined, writes = 0, lookups = 0;
  const command = defineCommand({ operation: 'save', load: async (n: number) => ok(n), decide: workflow('rule', (n: number) => ok(n)),
    save: async (n: number): Promise<Result<Execution<number>, 'UnknownCommit'>> => { writes++; saved = n; return err('UnknownCommit'); } });
  const replay = withReplay(command, { lookup: async () => { lookups++; return ok(saved === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, value: saved }); }, resolveAfter: error => error === 'UnknownCommit' });
  const app = defineApplication({ initial: () => 0, operations: { go: replayOperation(replay, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  const result = await session.dispatch({ type: 'go', input: 4 }); assert(result.ok && result.value.state.kind === 'ready');
  assert.deepEqual([writes, lookups], [1, 2]);
  assert.equal(ends(events).find(event => event.step === 'save')?.status, 'error');
  assert(starts(events).some(event => event.step === 'replay.lookup:after-error'));
  balanced(events);
});
test('replaced detailed methods do not accidentally execute an old private instrumentation capability', async () => {
  let original = 0, replacement = 0;
  const command = defineCommand({ operation: 'save', load: async (n: number) => { original++; return ok(n); }, decide: workflow('rule', (n: number) => ok(n)), save: async (n: number) => ok(n) });
  command.runDetailed = async n => { replacement++; return { result: ok(n + 10), trace: [{ step: 'replacement', status: 'ok' }], plan: null }; };
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, n) => n) }, view: state => state.data });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  const result = await session.dispatch({ type: 'go', input: 1 }); assert(result.ok && result.value.state.data === 11);
  assert.deepEqual([original, replacement], [0, 1]); assert.deepEqual(starts(events).map(event => event.step), ['application.project']);
  assert(events.some(event => event.kind === 'step' && event.step === 'replacement'));
});


test('projection defects retain a successful save span and identify the failed Application boundary', async () => {
  let writes = 0;
  const command = defineCommand({ operation: 'save', load: async (n: number) => ok(n), decide: workflow('rule', (n: number) => ok(n)), save: async (n: number) => { writes++; return ok(n); } });
  const app = defineApplication({ initial: () => 0, operations: { go: operation(command, (_: number, _n): number => { throw Error('SECRET_PROJECTION'); }) }, view: state => state.kind });
  const events: ExecutionEvent[] = [], session = await app.start({ observeExecution: event => events.push(event) });
  const result = await session.dispatch({ type: 'go', input: 4 }); assert(result.ok && result.value.state.kind === 'crashed');
  assert.equal(writes, 1); assert.equal(ends(events).find(event => event.step === 'save')?.status, 'ok');
  assert.equal(ends(events).find(event => event.step === 'application.project')?.status, 'defect');
  assert(!JSON.stringify(events).includes('SECRET_PROJECTION')); balanced(events);
});
