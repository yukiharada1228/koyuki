import test from 'node:test';
import assert from 'node:assert/strict';
import { business, process, workflow, ok } from './framework/index.js';

const brokenSelection = async () => { await Promise.resolve(); throw new Error('private capture failure'); };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('native async captures remain failed diagnostics without unhandled rejection after saving', async () => {
  let writes = 0;
  const commands = business({ name: 'capture', load: async (n: number) => ok(n),
    save: async (n: number) => { writes++; return ok(n); }, operations: { go: [(n: number) => ok(n + 1)] } });
  for (const phase of ['input', 'result'] as const) {
    const report = await commands.go.runDetailed(2, {
      input: phase === 'input' ? brokenSelection : () => null,
      result: phase === 'result' ? brokenSelection : () => null,
    });
    assert.deepEqual(report.result, ok(3));
    assert.deepEqual(report.observations, []);
    assert.equal(report.observationErrors.length, 3);
    assert(report.observationErrors.every(error => error.phase === phase && error.kind === 'CaptureFailed'));
    assert(!JSON.stringify(report).includes('private capture failure'));
    await settle();
  }
  assert.equal(writes, 2);
});

test('Process rejection and synchronous inspect contracts survive accidental async selection', async () => {
  let writes = 0, calls = 0;
  const pure = workflow('pure', (n: number) => { calls++; return ok(n + 1); });
  const task = process<number>().through(pure).effect('write', async n => { writes++; return ok(n); });
  const report = await task.runDetailed(2, { input: () => null, result: brokenSelection });
  assert.deepEqual(report.result, ok(3)); assert.equal(writes, 1);
  assert.deepEqual(report.observationErrors.map(error => error.step), ['pure', 'write']);
  assert.throws(() => pure.inspect(2, { input: brokenSelection, result: () => null }), { name: 'DataCloneError' });
  assert.equal(calls, 1);
  assert.throws(() => pure.inspect(2, { input: () => null, result: brokenSelection }), { name: 'DataCloneError' });
  assert.equal(calls, 2);
  await settle();
});

test('capture rejection handling never assimilates a data object through its then getter', async () => {
  let reads = 0, writes = 0;
  const selected = Object.defineProperty({}, 'then', { get() { reads++; throw new Error('unexpected getter'); } });
  const task = process<number>().effect('write', async n => { writes++; return ok(n); });
  const report = await task.runDetailed(1, { input: () => selected, result: () => null });
  assert.deepEqual(report.result, ok(1)); assert.equal(writes, 1); assert.equal(reads, 0);
  assert.deepEqual(report.observationErrors, [{ step: 'write', phase: 'input', kind: 'CaptureFailed' }]);
});

test('invalid Promise selections neither delay IO nor read fulfillment data or a Promise then getter', async () => {
  let reads = 0, writes = 0;
  const value = {};
  const fulfilled = Promise.resolve(value);
  // Resolution is already finished; the handler must not resolve another
  // Promise with this now-behavioral value.
  Object.defineProperty(value, 'then', { get() { reads++; throw new Error('fulfillment getter'); } });
  const rejected = Promise.reject(new Error('private rejection'));
  Object.defineProperty(rejected, 'then', { get() { reads++; throw new Error('Promise getter'); } });
  const pending = new Promise<unknown>(() => {});
  const task = process<number>().effect('write', async n => { writes++; return ok(n); });
  for (const selected of [fulfilled, rejected, pending]) {
    const report = await task.runDetailed(1, { input: () => selected, result: () => null });
    assert.deepEqual(report.result, ok(1));
    assert.deepEqual(report.observationErrors, [{ step: 'write', phase: 'input', kind: 'CaptureFailed' }]);
  }
  await settle();
  assert.equal(writes, 3); assert.equal(reads, 0);
});
