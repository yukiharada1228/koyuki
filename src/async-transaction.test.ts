import test from 'node:test';
import assert from 'node:assert/strict';
import { inTransaction, ok, err, type TransactionHost, type Result } from './framework/index.js';

test('callback transaction returns same failed Result only after confirmed rollback', async () => {
  const calls: string[] = [], scope = { id: 1 };
  const host: TransactionHost<typeof scope> = {
    async transaction(work) {
      calls.push('begin');
      try { const value = await work(scope); calls.push('commit'); return value; }
      catch (cause) { calls.push('rollback'); throw cause; }
    },
  };
  const denied = err('Denied' as const);
  assert.equal(await inTransaction(host, context => { assert.equal(context, scope); return denied; }), denied);
  const choose = (n: number) => n === 0 ? err('Zero' as const) : n < 0 ? err('Negative' as const) : ok(n);
  const result: Result<number, 'Zero' | 'Negative'> = await inTransaction(host, () => choose(1));
  assert.deepEqual(result, ok(1));
  assert.deepEqual(calls, ['begin', 'rollback', 'begin', 'commit']);
});
test('callback work exception and host failure retain their original identity', async () => {
  const defect = Error('defect');
  const host: TransactionHost<number> = { async transaction(work) { return work(1); } };
  await assert.rejects(inTransaction(host, () => { throw defect; }), e => e === defect);
  const commitFailure = Error('commit unknown');
  await assert.rejects(inTransaction({ async transaction(work) { await work(1); throw commitFailure; } }, () => ok(1)), e => e === commitFailure);
  const beginFailure = Error('begin');
  await assert.rejects(inTransaction({ async transaction() { throw beginFailure; } }, () => { assert.fail('not called'); }), e => e === beginFailure);
});
test('rollback failure or wrapped abort is not replaced with the business error', async () => {
  for (const wrapped of [true, false]) {
    let expected: unknown;
    const host: TransactionHost<number> = {
      async transaction(work) {
        try { return await work(1); }
        catch (cause) { expected = wrapped ? Error('wrapped', { cause }) : Error('rollback failed'); throw expected; }
      },
    };
    await assert.rejects(inTransaction(host, () => err('Denied')), e => e === expected);
  }
});
test('separate concurrent invocations cannot consume one another\'s abort marker', async () => {
  let firstAbort: unknown;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first: TransactionHost<number> = { async transaction(work) { try { return await work(1); } catch (cause) { firstAbort = cause; release(); throw cause; } } };
  const second: TransactionHost<number> = { async transaction(work) { await gate; try { return await work(2); } catch { throw firstAbort; } } };
  const results = await Promise.allSettled([inTransaction(first, () => err('First')), inTransaction(second, () => err('Second'))]);
  assert.deepEqual(results[0], { status: 'fulfilled', value: err('First') });
  assert.equal(results[1]?.status, 'rejected');
  if (results[1]?.status === 'rejected') assert.equal(results[1].reason, firstAbort);
});
test('callback host receiver and scoped input types survive public inference', async () => {
  const host = { id: 4, async transaction<T>(work: (context: { id: number }) => Promise<T>) { return work({ id: this.id }); } };
  const value = await inTransaction(host, async context => ok(context.id));
  assert.deepEqual(value, ok(4));
  if (false) {
    // @ts-expect-error context has only id, not an ambient/global connection
    await inTransaction(host, context => ok(context.global));
    // @ts-expect-error callback must return Result
    await inTransaction(host, () => 1);
  }
});
