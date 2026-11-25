import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operation, operations, replayOperation, replayOperations, ok, err, type Result, type Execution } from './framework/index.js';

for (const observed of [false, true]) test(`direct Application methods retain their class receiver (${observed ? 'detailed' : 'plain'})`, async () => {
  class Approval {
    #factor = 3;
    runs = 0; details = 0; reductions = 0;
    async run(input: number): Promise<Result<number, 'Negative'>> {
      this.runs++; return input < 0 ? err('Negative') : ok(input * this.#factor);
    }
    async runDetailed(input: number) {
      this.details++;
      return { result: input < 0 ? err('Negative' as const) : ok(input * this.#factor), trace: [], plan: null };
    }
    reduce(state: number, output: number) { this.reductions++; return state + output * this.#factor; }
  }
  const approval = new Approval();
  const app = defineApplication({ initial: () => 1, operations: { approve: approval }, view: state => state.data });
  const session = await app.start(observed ? { observeExecution: () => {} } : undefined);
  const result = await session.dispatch({ type: 'approve', input: 2 });
  assert(result.ok && result.value.state.kind === 'ready'); assert.equal(session.snapshot().view, 19);
  const failed = await session.dispatch({ type: 'approve', input: -1 });
  assert(failed.ok && failed.value.state.kind === 'failed'); assert.equal(failed.value.state.error, 'Negative');
  assert.equal(session.snapshot().view, 19);
  assert.deepEqual([approval.runs, approval.details, approval.reductions], observed ? [0, 2, 1] : [2, 0, 1]);
});

test('a receiver-dependent projection failure preserves prior state and does not repeat the operation', async () => {
  const entry = {
    calls: 0, reductions: 0, message: 'ProjectionFailed',
    async run(input: number) { this.calls++; return ok(input); },
    reduce(_state: number, _output: number): number { this.reductions++; throw new Error(this.message); },
  };
  const session = await defineApplication({ initial: () => 7, operations: { go: entry }, view: state => state.data }).start();
  const result = await session.dispatch({ type: 'go', input: 2 });
  assert(result.ok && result.value.state.kind === 'crashed');
  assert.equal(result.value.state.error.message, 'ProjectionFailed'); assert.equal(result.value.state.data, 7);
  assert.deepEqual([entry.calls, entry.reductions], [1, 1]);
});
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
