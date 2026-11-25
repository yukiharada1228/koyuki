import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operation, defineProgram, next, effect, ok, type Update } from './framework/index.js';

const flushRejections = () => new Promise<void>(resolve => setImmediate(resolve));
test('Application subscriber rejections preserve accepted IO and later notifications until disposal', async () => {
  let calls = 0;
  const app = defineApplication({ initial: () => 0, operations: {
    go: operation({ run: async (n: number) => { calls++; return ok(n); } }, (_before: number, n) => n),
  }, view: state => state.data });
  const session = await app.start(), seen: number[] = [];
  const dispose = session.subscribe(async snapshot => { seen.push(snapshot.view); await Promise.resolve(); throw Error('async presentation failure'); });
  const result = await session.dispatch({ type: 'go', input: 5 });
  await flushRejections();
  assert(result.ok && result.value.state.data === 5); assert.equal(calls, 1); assert.deepEqual(seen, [0, 0, 5]);
  dispose();
  assert((await session.dispatch({ type: 'go', input: 7 })).ok); await flushRejections();
  assert.equal(session.snapshot().state.data, 7); assert.equal(calls, 2); assert.deepEqual(seen, [0, 0, 5]);
});

test('Program subscriber rejections preserve the command sequence and synchronous initial failures stay unregistered', async () => {
  type Message = { type: 'start' } | { type: 'done'; n: number };
  let commands = 0, initialFailures = 0;
  const double = effect('double', async (n: number) => { commands++; return n * 2; }, (n): Message => ({ type: 'done', n }));
  const session = await defineProgram({ init: (): Update<number, Message> => next(0),
    update: (state: number, event: Message) => ok(event.type === 'start' ? next(state + 1, double(state + 1)) : next<number, Message>(event.n)),
    view: state => state,
  }).start();
  assert.throws(() => session.subscribe(() => { initialFailures++; throw Error('initial synchronous failure'); }), /initial synchronous failure/);
  const seen: number[] = [];
  session.subscribe(async snapshot => { seen.push(snapshot.state); await Promise.resolve(); throw Error('async presentation failure'); });
  const result = await session.dispatch({ type: 'start' }); await flushRejections();
  assert(result.ok); assert.equal(result.value.state, 2); assert.equal(commands, 1); assert.equal(initialFailures, 1);
  assert.deepEqual(seen, [0, 1, 2]); assert.deepEqual(session.trace().map(row => row.name), ['start', 'double', 'done']);
});
