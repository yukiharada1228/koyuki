import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProgram, next, effect, ok, err, type ExecutionEvent } from './framework/index.js';
type Message = { type: 'go' | 'done' | 'reject'; value: number };
const metadata = (events: ExecutionEvent[]) => events.filter(event => event.kind === 'queued' || event.kind === 'started' || event.kind === 'completed');

test('Program reports a pending effect and its completion under the dispatch execution without repeating work', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const pendingEffect = new Promise<void>(resolve => { entered = resolve; });
  const events: ExecutionEvent[] = []; let writes = 0;
  const work = effect('save', async (n: number) => { writes++; entered(); await gate; return n + 1; }, n => ({ type: 'done' as const, value: n }));
  const app = defineProgram({ init: () => next<number, Message>(0),
    update: (state: number, message: Message) => message.type === 'go' ? ok(next<number, Message>(state, work(message.value))) : ok(next<number, Message>(message.value)),
    view: state => state });
  let time = 0;
  const session = await app.start({ sessionId: 'program', clock: () => ++time, observeExecution: event => { events.push(event); } });
  events.length = 0;
  const operation = session.dispatch({ type: 'go', value: 3 }); await pendingEffect;
  const span = events.find(event => event.kind === 'span-started' && event.step === 'save'); assert(span && span.kind === 'span-started');
  const root = events.find(event => event.kind === 'span-started' && event.step === 'program.dispatch'); assert(root && root.kind === 'span-started');
  assert.equal(span.parentSpanId, root.spanId);
  assert(!events.some(event => event.kind === 'completed'));
  assert(!events.some(event => event.kind === 'span-completed' && event.spanId === span.spanId));
  release(); const result = await operation; assert(result.ok); assert.equal(result.value.state, 4); assert.equal(writes, 1);
  assert.deepEqual(metadata(events).map(event => event.kind), ['queued', 'started', 'completed']);
  assert(events.every(event => event.executionId === 'program/2' && event.operation === 'go' && Object.isFrozen(event)));
  assert(events.some(event => event.kind === 'span-completed' && event.step === 'save' && event.status === 'ok' && event.durationMs > 0));
  assert(events.some(event => event.kind === 'span-completed' && event.step === 'program.update:done'));
  assert(!JSON.stringify(events).includes('"value"'));
});

test('Program distinguishes rejected business updates, stale dispatches, and exact thrown defects and continues after them', async () => {
  const events: ExecutionEvent[] = [], defect = new Error('private defect');
  const session = await defineProgram({ init: () => next<number, Message>(0), update: (_state: number, m: Message) => {
    if (m.type === 'reject') return err('Denied' as const);
    if (m.value === 13) throw defect;
    return ok(next<number, Message>(m.value));
  }, view: s => s }).start({ observeExecution: event => { events.push(event); } });
  events.length = 0;
  assert.deepEqual(await session.dispatch({ type: 'reject', value: 0 }), err('Denied'));
  assert.deepEqual(await session.dispatch({ type: 'go', value: 1 }, 9), err({ kind: 'StaleRevision' }));
  await assert.rejects(session.dispatch({ type: 'go', value: 13 }), error => error === defect);
  assert.equal(session.snapshot().revision, 0);
  assert((await session.dispatch({ type: 'go', value: 2 })).ok);
  assert.deepEqual(events.filter(event => event.kind === 'completed').map(event => event.status), ['error', 'rejected', 'defect', 'ok']);
  assert(!JSON.stringify(events).includes('private defect'));
});

test('initial commands share initialization execution and a failing command remains a defect', async () => {
  const events: ExecutionEvent[] = [], defect = new Error('IO'); let writes = 0;
  const command = effect('initial-save', async (_: number) => { writes++; throw defect; }, () => ({ type: 'done' as const, value: 0 }));
  const program = defineProgram({ init: () => next<number, Message>(0, command(1)), update: (_s: number, m: Message) => ok(next<number, Message>(m.value)), view: s => s });
  await assert.rejects(program.start({ observeExecution: event => { events.push(event); } }), error => error === defect);
  assert.equal(writes, 1); assert(events.every(event => event.operation === '@init'));
  assert(events.some(event => event.kind === 'span-completed' && event.step === 'initial-save' && event.status === 'defect'));
  const last = events.at(-1); assert(last?.kind === 'completed'); assert.equal(last.status, 'defect');
});

test('state acceptance failure after IO reports the successful command and preserves the accepted state', async () => {
  type State = { value: number; invalid?: symbol };
  const events: ExecutionEvent[] = []; let writes = 0;
  const command = effect('persist', async (n: number) => { writes++; return n + 1; }, n => ({ type: 'done' as const, value: n }));
  const session = await defineProgram({ init: () => next<State, Message>({ value: 0 }),
    update: (_state: State, m: Message) => m.type === 'go'
      ? ok(next<State, Message>({ value: m.value }, command(m.value)))
      : ok(next<State, Message>({ value: m.value, invalid: Symbol('cannot-snapshot') })), view: s => s.value })
    .start({ observeExecution: event => { events.push(event); } });
  events.length = 0;
  await assert.rejects(session.dispatch({ type: 'go', value: 1 }));
  assert.equal(writes, 1); assert.equal(session.snapshot().state.value, 1); assert.equal(session.snapshot().revision, 1);
  assert(events.some(event => event.kind === 'span-completed' && event.step === 'persist' && event.status === 'ok'));
  assert(events.some(event => event.kind === 'span-completed' && event.step === 'program.accept' && event.status === 'defect'));
  const last = events.at(-1); assert(last?.kind === 'completed'); assert.equal(last.status, 'defect');
  const count = events.length;
  await assert.rejects(session.dispatch({ type: 'go', value: 1, invalid: Symbol('input') } as Message));
  assert.equal(events.length, count); assert.equal(writes, 1);
});

test('observer throws and rejected promises do not alter execution; subscription can be removed', async () => {
  let updates = 0;
  const session = await defineProgram({ init: () => next<number, Message>(0), update: (_s: number, m: Message) => { updates++; return ok(next<number, Message>(m.value)); }, view: s => s })
    .start({ observeExecution: () => { throw new Error('observer'); }, clock: () => { throw new Error('clock'); } });
  const events: ExecutionEvent[] = [];
  const stop = session.subscribeExecution(event => { events.push(event); return Promise.reject(new Error('observer rejected')); });
  assert((await session.dispatch({ type: 'go', value: 4 })).ok); stop(); const count = events.length;
  assert((await session.dispatch({ type: 'go', value: 5 })).ok); assert.equal(events.length, count);
  assert.equal(updates, 2); assert.equal(session.snapshot().state, 5);
  assert(events.every(event => event.elapsedMs === 0));
});

test('queued executions stay separate while their first effect is pending', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const events: ExecutionEvent[] = [];
  const command = effect('wait', async (n: number) => { entered(); await gate; return n; }, n => ({ type: 'done' as const, value: n }));
  const session = await defineProgram({ init: () => next<number, Message>(0), update: (s: number, m: Message) => m.type === 'go'
    ? ok(next<number, Message>(s, command(m.value))) : ok(next<number, Message>(m.value)), view: s => s })
    .start({ sessionId: 'queued', observeExecution: event => { events.push(event); } });
  events.length = 0;
  let second: ReturnType<typeof session.dispatch> | undefined;
  const stop = session.subscribeExecution(event => {
    if (event.executionId === 'queued/2' && event.kind === 'queued') second = session.dispatch({ type: 'go', value: 2 });
  });
  const first = session.dispatch({ type: 'go', value: 1 }); await enteredGate;
  assert(second);
  assert(events.some(event => event.executionId === 'queued/3' && event.kind === 'queued'));
  assert(!events.some(event => event.executionId === 'queued/3' && event.kind === 'started'));
  release(); await first; await second; stop();
  assert.equal(session.snapshot().state, 2);
  const finished = events.findIndex(event => event.executionId === 'queued/2' && event.kind === 'completed');
  const started = events.findIndex(event => event.executionId === 'queued/3' && event.kind === 'started');
  assert(started > finished);
  for (const event of events) if (event.kind === 'span-started' && event.parentSpanId) assert(event.parentSpanId.startsWith(event.executionId + '/'));
});
