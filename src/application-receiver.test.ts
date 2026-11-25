import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operation, operations, replayOperation, replayOperations, ok, err, type Result, type Execution } from './framework/index.js';
function command() {
  return { amount: 3, calls: 0, async run(input: number): Promise<Result<number, 'Negative'>> {
    this.calls++;
    return input < 0 ? err('Negative') : ok(input * this.amount);
  } };
}
for (const grouped of [false, true]) test(`Application preserves the command receiver (${grouped ? 'table' : 'single'})`, async () => {
  const source = command();
  const reduce = (state: number, value: number) => state + value;
  const app = defineApplication({ initial: () => 0,
    operations: grouped ? operations({ add: source }, reduce) : { add: operation(source, reduce) }, view: state => state.data });
  const session = await app.start();
  await session.dispatch({ type: 'add', input: 2 });
  assert.equal(session.snapshot().view, 6); assert.equal(source.calls, 1);
  await session.dispatch({ type: 'add', input: -1 });
  assert.equal(session.snapshot().state.kind, 'failed');
  assert.equal(session.snapshot().view, 6); assert.equal(source.calls, 2);
});
for (const grouped of [false, true]) test(`replay registration preserves receiver and skips projection on replay (${grouped ? 'table' : 'single'})`, async () => {
  const source = { amount: 4, calls: 0, async run(input: number): Promise<Result<Execution<number>, never>> {
    this.calls++; return ok({ kind: input === 0 ? 'replayed' : 'committed', value: this.amount });
  } };
  const reduce = (state: number, value: number) => state + value;
  const app = defineApplication({ initial: () => 1,
    operations: grouped ? replayOperations({ add: source }, reduce) : { add: replayOperation(source, reduce) }, view: state => state.data });
  const session = await app.start();
  await session.dispatch({ type: 'add', input: 1 });
  assert.equal(session.snapshot().view, 5);
  await session.dispatch({ type: 'add', input: 0 });
  assert.equal(session.snapshot().view, 5); assert.equal(source.calls, 2);
});
