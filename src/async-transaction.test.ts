import test from 'node:test';
import assert from 'node:assert/strict';
import { TransactionHostFailure, inTransaction, ok, err, type TransactionHost, type Result } from './framework/index.js';

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


test('host retry cannot execute work a second time, even if the host swallows the guard', async () => {
  for (const success of [true, false]) {
    let writes = 0;
    const host: TransactionHost<number> = {
      async transaction(work) {
        let first: unknown;
        try { first = await work(1); } catch { /* broken driver's retry */ }
        try { return await work(2); }
        catch { return first as never; }
      },
    };
    await assert.rejects(inTransaction(host, () => { writes++; return success ? ok(1) : err('Denied'); }), e => e instanceof TransactionHostFailure && e.reason === 'repeated-callback' && e.outcome === 'unknown');
    assert.equal(writes, 1);
  }
});
test('host cannot turn a failed Result or a work exception into success', async () => {
  for (const defect of [true, false]) {
    const host: TransactionHost<number> = { async transaction(work) { try { return await work(1); } catch { return ok(7) as never; } } };
    await assert.rejects(inTransaction(host, () => { if (defect) throw Error('work'); return err('Denied'); }), e => e instanceof TransactionHostFailure && e.reason === 'swallowed-failure');
  }
});
test('host cannot return before work completes, and late callbacks never start work', async () => {
  let later: (() => Promise<unknown>) | undefined, writes = 0;
  const host: TransactionHost<number> = { async transaction(work) { later = () => work(1); return ok(1) as never; } };
  await assert.rejects(inTransaction(host, () => { writes++; return ok(1); }), e => e instanceof TransactionHostFailure && e.reason === 'missing-callback');
  assert(later);
  await assert.rejects(later(), e => e instanceof TransactionHostFailure && e.reason === 'missing-callback');
  assert.equal(writes, 0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let running: Promise<unknown> | undefined;
  const early: TransactionHost<number> = { async transaction(work) { running = work(1); return ok(1) as never; } };
  await assert.rejects(inTransaction(early, async () => { await gate; return ok(2); }), e => e instanceof TransactionHostFailure && e.reason === 'unfinished-callback');
  release(); await running; // Work already started cannot be cancelled by this check.
});
test('host must return the exact success Result, rather than manufacture an output', async () => {
  const host: TransactionHost<number> = { async transaction(work) { await work(1); return ok('wrong') as never; } };
  await assert.rejects(inTransaction(host, () => ok(1)), e => e instanceof TransactionHostFailure && e.reason === 'changed-result');
});

test('callback retained after a successful transaction cannot run another operation', async () => {
  let later: (() => Promise<unknown>) | undefined, writes = 0;
  const host: TransactionHost<number> = { async transaction(work) { later = () => work(2); return work(1); } };
  assert.deepEqual(await inTransaction(host, () => { writes++; return ok(1); }), ok(1));
  assert(later);
  await assert.rejects(later(), e => e instanceof TransactionHostFailure && e.reason === 'late-callback');
  assert.equal(writes, 1);
});

test('concurrent callback attempts in one host invocation start only one work function', async () => {
  let release!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host: TransactionHost<number> = {
    async transaction(work) {
      const first = work(1), second = work(2);
      const settled = Promise.allSettled([first, second]);
      release();
      await settled; // A broken host swallows the second callback's rejection.
      return first;
    },
  };
  await assert.rejects(inTransaction(host, async () => { started++; await gate; return ok(1); }), e => e instanceof TransactionHostFailure && e.reason === 'repeated-callback');
  assert.equal(started, 1);
});
