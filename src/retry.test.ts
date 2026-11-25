import test from 'node:test';
import assert from 'node:assert/strict';
import { retryEffect, ok, err, process as effectProcess, type Result, type RetryDecision } from './framework/index.js';
const retry = (): RetryDecision => ({ kind: 'retry', safety: 'not-applied', delayMs: 0 });
test('retry preserves success and terminal error identity without an extra invocation', async () => {
  const success = ok({ id: 1 }), failure = err('Denied' as const); let calls = 0, decisions = 0;
  const first = retryEffect(async (_n: number) => { calls++; return success; }, { maxAttempts: 3, decide: () => { decisions++; return retry(); } });
  assert.equal(await first(1), success); assert.deepEqual([calls, decisions], [1, 0]);
  const denied = retryEffect(async (_n: number) => { calls++; return failure; }, { maxAttempts: 3, decide: () => ({ kind: 'stop' }) });
  assert.equal(await denied(1), failure); assert.equal(calls, 2);
});
test('explicitly classified no-effect failures retry with bounded attempt numbers', async () => {
  const attempts: number[] = [];
  const run = retryEffect(async (n: number, execution): Promise<Result<number, 'Offline'>> => { attempts.push(execution.attempt); return execution.attempt < 3 ? err('Offline') : ok(n * 2); }, { maxAttempts: 3, decide: error => error === 'Offline' ? retry() : { kind: 'stop' } });
  assert.deepEqual(await run(3), ok(6)); assert.deepEqual(attempts, [1, 2, 3]);
});
test('attempt exhaustion returns the last error and does not ask for another retry', async () => {
  const failure = err('Offline'); let calls = 0, decisions = 0;
  const run = retryEffect(async (_n: number) => { calls++; return failure; }, { maxAttempts: 2, decide: () => { decisions++; return retry(); } });
  assert.equal(await run(1), failure); assert.deepEqual([calls, decisions], [2, 1]);
});
test('caller and adapter mutations cannot change the DTO between attempts', async () => {
  const request = { id: 'same-key', nested: { amount: 3 } }, seen: unknown[] = [];
  const run = retryEffect(async (input: typeof request, execution): Promise<Result<number, 'Offline'>> => {
    seen.push(structuredClone(input)); input.nested.amount = 99;
    return execution.attempt === 1 ? err('Offline') : ok(6);
  }, { maxAttempts: 2, decide: retry });
  const pending = run(request); request.id = 'other-key'; request.nested.amount = 100;
  assert.deepEqual(await pending, ok(6)); assert.deepEqual(seen, [{ id: 'same-key', nested: { amount: 3 } }, { id: 'same-key', nested: { amount: 3 } }]);
});
test('pre-aborted requests and unrepresentable inputs do not invoke the effect', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const run = retryEffect(async (_input: unknown) => { calls++; return ok(1); }, { maxAttempts: 2, decide: retry });
  assert.deepEqual(await run({}, { signal: controller.signal }), err({ kind: 'RetryInterrupted', attempts: 0 }));
  assert.deepEqual(await run({ callback() {} }), err({ kind: 'RetryInputNotCloneable' })); assert.equal(calls, 0);
});
test('abort during retry waiting stops the next attempt', async () => {
  const controller = new AbortController(); let calls = 0;
  const run = retryEffect(async (_n: number) => { calls++; return err('Offline' as const); }, { maxAttempts: 3, decide: () => {
    queueMicrotask(() => controller.abort()); return { kind: 'retry', safety: 'not-applied', delayMs: 10000 };
  } });
  assert.deepEqual(await run(1, { signal: controller.signal }), err({ kind: 'RetryInterrupted', attempts: 1, lastError: 'Offline' })); assert.equal(calls, 1);
});
test('in-flight completion is awaited and success is preserved after cancellation', async () => {
  const controller = new AbortController(); let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = retryEffect(async (_n: number, execution) => { calls++; assert.equal(execution.signal, controller.signal); await gate; return ok('committed'); }, { maxAttempts: 3, decide: retry });
  let settled = false; const pending = run(1, { signal: controller.signal }).then(result => { settled = true; return result; });
  controller.abort(); await Promise.resolve(); assert.equal(settled, false); release();
  assert.deepEqual(await pending, ok('committed')); assert.equal(calls, 1);
});
test('failure completed after cancellation includes the last error without another attempt', async () => {
  const controller = new AbortController(); let decisions = 0;
  const run = retryEffect(async (_n: number) => { controller.abort(); return err('UnknownCommit'); }, { maxAttempts: 3, decide: () => { decisions++; return retry(); } });
  assert.deepEqual(await run(1, { signal: controller.signal }), err({ kind: 'RetryInterrupted', attempts: 1, lastError: 'UnknownCommit' })); assert.equal(decisions, 0);
});
test('unexpected effect and policy exceptions reject without being converted into retries', async () => {
  const cause = Error('defect'); let calls = 0;
  const broken = retryEffect(async (_n: number): Promise<Result<number, string>> => { calls++; throw cause; }, { maxAttempts: 3, decide: retry });
  await assert.rejects(broken(1), error => error === cause); assert.equal(calls, 1);
  const policy = retryEffect(async (_n: number) => err('Offline'), { maxAttempts: 3, decide: () => { throw cause; } });
  await assert.rejects(policy(1), error => error === cause);
});
test('invalid policies fail before additional IO', async () => {
  let calls = 0; const effect = async (_n: number) => { calls++; return err('Offline'); };
  for (const maxAttempts of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => retryEffect(effect, { maxAttempts, decide: retry }), /InvalidRetryAttempts/);
  assert.equal(calls, 0);
  for (const delayMs of [-1, NaN, Infinity, 0.5, 2147483648]) {
    const run = retryEffect(effect, { maxAttempts: 2, decide: () => ({ kind: 'retry', safety: 'not-applied', delayMs }) });
    await assert.rejects(run(1), /InvalidRetryDecision/);
  }
  assert.equal(calls, 5);
});
test('concurrent invocations keep independent attempt counters and compose as a Process stage', async () => {
  const calls: Record<string, number[]> = {};
  const run = retryEffect(async (id: string, { attempt }): Promise<Result<string, 'Offline'>> => { (calls[id] ??= []).push(attempt); return attempt === 1 ? err('Offline') : ok(id); }, { maxAttempts: 2, decide: retry });
  assert.deepEqual(await Promise.all([run('a'), run('b')]), [ok('a'), ok('b')]); assert.deepEqual(calls, { a: [1, 2], b: [1, 2] });
  const report = await effectProcess<string>().effect('read-with-retry', run).runDetailed('c');
  assert.deepEqual(report.result, ok('c')); assert.deepEqual(report.trace, [{ step: 'read-with-retry', status: 'ok' }]);
});
if (false) {
  // @ts-expect-error a retry requires an explicit safety assertion
  const missingSafety: RetryDecision = { kind: 'retry', delayMs: 0 };
  const run = retryEffect(async (n: number): Promise<Result<number, 'Offline'>> => ok(n), { maxAttempts: 2, decide: retry });
  // @ts-expect-error error classifiers cannot assume an unrelated error type
  retryEffect(async (n: number): Promise<Result<number, 'Offline'>> => ok(n), { maxAttempts: 2, decide: (_error: 'Denied') => ({ kind: 'stop' }) });
  // @ts-expect-error original input type is preserved
  run('wrong');
  void missingSafety;
}
