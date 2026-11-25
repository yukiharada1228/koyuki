import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, type Result, type WorkflowCapture, type Execution, type Receipt } from './framework/index.js';
const numbers: WorkflowCapture<number, string> = { input: value => Number(value), result: result => result.ok ? String(result.value) : 'failed' };
test('business captures load, every rule and save exactly once with typed selected values', async () => {
  const calls: string[] = [];
  let resolved = 0;
  const commands = business({ name: 'counter', operation: () => { resolved++; return 'stable-id'; },
    load: async (n: number) => { calls.push('load'); return ok(n); },
    save: async (n: number) => { calls.push('save'); return ok(n); },
    operations: { add: [(n: number) => { calls.push('rule'); return ok(n + 1); }] },
  });
  const report = await commands.add.runDetailed(2, numbers);
  assert.deepEqual(report.result, ok(3)); assert.deepEqual(calls, ['load', 'rule', 'save']);
  assert.deepEqual(report.observations, [
    { step: 'stable-id:load', input: 2, result: '2' }, { step: 'run:1', input: 2, result: '3' }, { step: 'stable-id', input: 3, result: '3' },
  ]);
  assert.deepEqual(report.observationErrors, []); assert.equal(resolved, 1);
  const observedNumber: number = report.observations[0]!.input;
  const observedString: string = report.observations[0]!.result;
  void [observedNumber, observedString];
  const normal = await commands.add.runDetailed(2); assert(!('observations' in normal)); assert.equal(resolved, 1);
});
test('expected failures record only executed stages and preserve the exact domain failure', async () => {
  for (const phase of ['load', 'rule', 'save']) {
    const failure = { kind: 'Denied' as const };
    const commands = business({ name: 'fail', load: async (n: number): Promise<Result<number, typeof failure>> => phase === 'load' ? err(failure) : ok(n),
      save: async (n: number): Promise<Result<number, typeof failure>> => phase === 'save' ? err(failure) : ok(n),
      operations: { go: [(n: number): Result<number, typeof failure> => phase === 'rule' ? err(failure) : ok(n)] } });
    const report = await commands.go.runDetailed(1, numbers);
    assert(!report.result.ok); assert.equal(report.result.error, failure);
    assert.deepEqual(report.observations.map(entry => entry.step), phase === 'load' ? ['fail.go:load'] : phase === 'rule' ? ['fail.go:load', 'run:1'] : ['fail.go:load', 'run:1', 'fail.go']);
    assert.equal(report.observations.at(-1)?.result, 'failed');
  }
});
test('capture failures are diagnostics and never turn a committed result into a business failure', async () => {
  let saves = 0;
  const commands = business({ name: 'observe', load: async (n: number) => ok(n), save: async (n: number) => { saves++; return ok(n); }, operations: { go: [(n: number) => ok(n)] } });
  const report = await commands.go.runDetailed(3, {
    input: () => { throw new Error('private input'); }, result: () => { assert.fail('input capture failed'); },
  });
  assert.deepEqual(report.result, ok(3)); assert.equal(saves, 1); assert.deepEqual(report.observations, []);
  assert.equal(report.observationErrors.length, 3); assert(!JSON.stringify(report.observationErrors).includes('private input'));
  const afterSave = await commands.go.runDetailed(4, { input: x => x, result: (_result, name) => name === 'observe.go' ? () => 'uncloneable' : null });
  assert.deepEqual(afterSave.result, ok(4)); assert.equal(saves, 2);
  assert.deepEqual(afterSave.observationErrors, [{ step: 'observe.go', phase: 'result', kind: 'CaptureFailed' }]);
});
function replayFixture(unknownCommit = false) {
  let receipt: number | undefined, writes = 0, loads = 0;
  const commands = business({ name: 'receipt', load: async (n: number) => { loads++; return ok(n); },
    save: async (n: number): Promise<Result<Execution<number>, { kind: 'UnknownCommit' }>> => {
      writes++; receipt = n; return unknownCommit ? err({ kind: 'UnknownCommit' }) : ok({ kind: 'committed', value: n });
    }, replay: { lookup: (): Result<Receipt<number>, never> => ok(receipt === undefined ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: ['UnknownCommit'] },
    operations: { go: [(n: number) => ok(n * 2)] } });
  return { commands, counts: () => ({ writes, loads }) };
}
test('replay records only actual receipt lookup and never invents historical stage values', async () => {
  const f = replayFixture();
  const first = await f.commands.go.runDetailed(2, { input: () => null, result: value => value.ok });
  assert(first.result.ok); assert.equal(first.result.value.kind, 'committed');
  assert.deepEqual(first.observations.map(o => o.step), ['receipt.go:lookup:1', 'receipt.go:load', 'run:1', 'receipt.go']);
  const cached = await f.commands.go.runDetailed(2, { input: () => null, result: value => value.ok });
  assert(cached.result.ok); assert.equal(cached.result.value.kind, 'replayed'); assert.equal(cached.attempt, null);
  assert.deepEqual(cached.observations.map(o => o.step), ['receipt.go:lookup:1']);
  assert.deepEqual(f.counts(), { writes: 1, loads: 1 });
});
test('unknown commit recovery retains both lookup observations without another save', async () => {
  const f = replayFixture(true), report = await f.commands.go.runDetailed(2, { input: () => null, result: value => value.ok });
  assert(report.result.ok); assert.equal(report.result.value.kind, 'replayed');
  assert.deepEqual(report.observations.map(o => o.step), ['receipt.go:lookup:1', 'receipt.go:load', 'run:1', 'receipt.go', 'receipt.go:lookup:2']);
  assert.deepEqual(f.counts(), { writes: 1, loads: 1 });
});
test('concurrent observations and selected snapshots stay isolated', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commands = business({ name: 'parallel', load: async (n: number) => { if (n === 1) await gate; return ok(n); }, save: async (n: number) => ok(n), operations: { go: [(n: number) => ok(n + 10)] } });
  const slow = commands.go.runDetailed(1, numbers), fast = await commands.go.runDetailed(2, numbers);
  release(); const first = await slow;
  assert.deepEqual(fast.observations.map(o => o.input), [2, 2, 12]); assert.deepEqual(first.observations.map(o => o.input), [1, 1, 11]);
  assert(Object.isFrozen(first.observations)); assert(Object.isFrozen(first.observationErrors));
});
