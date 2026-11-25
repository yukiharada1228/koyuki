import test from 'node:test';
import assert from 'node:assert/strict';
import { fromThrowable, fromPromise, defineUseCase, defineTransition, ok, err, type Result } from './framework/index.js';
const unavailable = (cause: unknown) => ({ kind: 'Unavailable' as const, cause });

test('exception adapters are lazy and preserve argument tuples and unknown causes', async () => {
  let calls = 0;
  const parse = fromThrowable((text: string, radix: number) => { calls++; return Number.parseInt(text, radix); }, unavailable);
  assert.equal(calls, 0); assert.deepEqual(parse('10', 16), ok(16));
  const cause = Symbol('failure');
  assert.deepEqual(fromThrowable(() => { throw cause; }, unavailable)(), err({ kind: 'Unavailable', cause }));
  const read = fromPromise(async (id: string, count: number) => { calls++; return { id, count }; }, unavailable);
  assert.equal(calls, 1); assert.deepEqual(await read('a', 2), ok({ id: 'a', count: 2 }));
  if (false) {
    // @ts-expect-error source argument types remain enforced
    parse(10, 16);
    // @ts-expect-error source arity remains enforced
    read('a');
  }
});

test('promise boundary catches synchronous throws, rejections and thenable failures', async () => {
  const cause = { code: 'offline' };
  for (const perform of [
    (): Promise<number> => { throw cause; },
    () => Promise.reject<number>(cause),
    () => ({ then: () => { throw cause; } }) as PromiseLike<number>,
  ]) assert.deepEqual(await fromPromise(perform, unavailable)(), err({ kind: 'Unavailable', cause }));
});

test('failure mapper defects remain exceptions and existing Results are not flattened', async () => {
  const mapper = () => { throw new Error('mapper defect'); };
  assert.throws(() => fromThrowable(() => { throw 1; }, mapper)(), /mapper defect/);
  await assert.rejects(fromPromise(() => Promise.reject(1), mapper)(), /mapper defect/);
  assert.deepEqual(await fromPromise(async () => err('Business'), unavailable)(), ok(err('Business')));
});

test('adapted IO composes with declared workflow and stops before evolve or save', async () => {
  const calls: string[] = [];
  const load = fromPromise(async (_id: string): Promise<number> => { calls.push('load'); throw new Error('offline'); }, () => ({ kind: 'Unavailable' as const }));
  const save = fromPromise(async (n: number) => { calls.push('save'); return n; }, () => ({ kind: 'Unavailable' as const }));
  const useCase = defineUseCase({ operation: 'boundary', load,
    transition: defineTransition({ validate: (n: number) => { calls.push('validate'); return ok(n); },
      evolve: (n: number) => { calls.push('evolve'); return ok(n + 1); } }),
    save,
  });
  const result: Result<number, { kind: 'Unavailable' }> = await useCase.run('a');
  assert.deepEqual(result, err({ kind: 'Unavailable' })); assert.deepEqual(calls, ['load']);
});
