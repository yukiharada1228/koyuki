import test from 'node:test';
import assert from 'node:assert/strict';
import { process, ok, err, type Result, type ActionReport } from './framework/index.js';
test('detailed effect retains nested trace and calls the command exactly once', async () => {
  let calls = 0;
  const command = { async runDetailed(input: number): Promise<ActionReport<string, 'Denied'>> {
    calls++;
    return { result: ok(String(input)), trace: [{ step: 'nested-load', status: 'ok' }], plan: { private: true } };
  } };
  const flow = process<number>().effect('nested', command).effect('length', async value => ok(value.length));
  assert.equal(calls, 0);
  assert.deepEqual(await flow.runDetailed(12), { result: ok(2), trace: [
    { step: 'nested-load', status: 'ok' }, { step: 'nested', status: 'ok' }, { step: 'length', status: 'ok' },
  ], plan: null });
  assert.equal(calls, 1);
});
test('detailed failure keeps nested failure trace and prevents all later effects', async () => {
  const failure = { kind: 'Denied' } as const;
  let later = 0;
  const flow = process<number>().effect('nested', { async runDetailed(input: number) {
    return { result: err(failure), trace: [{ step: 'authorize', status: 'error' as const }], plan: input };
  } }).effect('later', async (_value: never) => { later++; return ok('unexpected'); });
  const report = await flow.runDetailed(1);
  assert(!report.result.ok); assert.equal(report.result.error, failure);
  assert.deepEqual(report.trace, [{ step: 'authorize', status: 'error' }, { step: 'nested', status: 'error' }]);
  assert.equal(later, 0);
});
test('detailed effects retain method receiver, isolate reports, and propagate defects', async () => {
  const command = { suffix: '!', async runDetailed(input: string) {
    return { result: ok(input + this.suffix), trace: [{ step: input, status: 'ok' as const }], plan: null };
  } };
  const flow = process<string>().effect('nested', command);
  const [a, b] = await Promise.all([flow.runDetailed('a'), flow.runDetailed('b')]);
  assert.deepEqual(a.result, ok('a!')); assert.deepEqual(b.result, ok('b!'));
  assert.equal(a.trace[0]?.step, 'a'); assert.equal(b.trace[0]?.step, 'b');
  const defect = new Error('defect');
  await assert.rejects(process<string>().effect('broken', { async runDetailed(_input: string): Promise<ActionReport<string, never>> {
    throw defect;
  } }).run('x'), error => error === defect);
});
// Compile-time contracts for declaration consumers.
const typed = process<number>().effect('typed', { async runDetailed(input: number): Promise<ActionReport<string, 'Denied'>> {
  return { result: ok(String(input)), trace: [], plan: null };
} });
const result: Promise<Result<string, 'Denied'>> = typed.run(1);
void result;
if (false) {
  // @ts-expect-error the command must consume the preceding output
  process<number>().effect('wrong', { async runDetailed(input: string) { return { result: ok(input), trace: [], plan: null }; } });
  // @ts-expect-error a replay report is not an ActionReport (no plan, different trace semantics)
  process<number>().effect('replay', { async runDetailed(input: number) { return { result: ok(input), trace: [], attempt: null }; } });
}
