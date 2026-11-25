import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, type Result, type Execution, type ReplayInputError } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Input = { id: string; value: number };

test('inline replay ports infer exact operation and request types and preserve all failures', async () => {
  const calls: string[] = [];
  const app = business({ name: 'inline',
    load: async (input: Input): Promise<Result<number, 'LoadFailed'>> => { calls.push('load'); return input.value < 0 ? err('LoadFailed') : ok(input.value); },
    operations: { go: [(n: number): Result<number, 'Invalid'> => { calls.push('rule'); return n === 0 ? err('Invalid') : ok(n + 1); }] },
    save: async (value: number, execution) => {
      type Name = Assert<Equal<typeof execution.name, 'go'>>;
      type Request = Assert<Equal<typeof execution.request, Input>>;
      calls.push('save'); assert.equal(execution.request.value + 1, value);
      return value === 14 ? err('SaveFailed' as const) : ok({ kind: 'committed' as const, value });
    },
    replay: { lookup: execution => {
      type Name = Assert<Equal<typeof execution.name, 'go'>>;
      type Request = Assert<Equal<typeof execution.request, Input>>;
      calls.push('lookup');
      return execution.request.id === 'failure' ? err('LookupFailed' as const)
        : execution.request.id === 'history' ? ok({ kind: 'found' as const, value: 90 }) : ok({ kind: 'missing' as const });
    }, resolveAfter: [] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.go>>, Result<Execution<number>, 'LoadFailed' | 'Invalid' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>>>;
  assert.deepEqual(await app.go({ id: 'new', value: 2 }), ok({ kind: 'committed', value: 3 }));
  assert.deepEqual(calls.splice(0), ['lookup', 'load', 'rule', 'save']);
  assert.deepEqual(await app.go({ id: 'history', value: 2 }), ok({ kind: 'replayed', value: 90 }));
  assert.deepEqual(calls.splice(0), ['lookup']);
  for (const [input, error, expected] of [
    [{ id: 'failure', value: 2 }, 'LookupFailed', ['lookup']],
    [{ id: 'new', value: -1 }, 'LoadFailed', ['lookup', 'load']],
    [{ id: 'new', value: 0 }, 'Invalid', ['lookup', 'load', 'rule']],
    [{ id: 'new', value: 13 }, 'SaveFailed', ['lookup', 'load', 'rule', 'save']],
  ] as const) {
    assert.deepEqual(await app.go(input), err(error)); assert.deepEqual(calls.splice(0), expected);
  }
});

test('numeric inline replay names are strings and historical alternatives remain possible', async () => {
  type State = { state: 'draft' } | { state: 'approved'; by: string };
  const app = business({ name: 'numeric', load: async (input: Input) => ok(input.value),
    operations: { 0: [(_n: number) => ok({ state: 'draft' as const })] },
    save: async (value: State, execution) => {
      type Name = Assert<Equal<typeof execution.name, '0'>>;
      type Request = Assert<Equal<typeof execution.request, Input>>;
      assert.equal(execution.name, '0'); return ok({ kind: 'committed' as const, value });
    },
    replay: { lookup: execution => {
      type Name = Assert<Equal<typeof execution.name, '0'>>;
      assert.equal(execution.name, '0');
      return execution.request.id === 'history'
        ? ok({ kind: 'found' as const, value: { state: 'approved' as const, by: 'boss' } }) : ok({ kind: 'missing' as const });
    }, resolveAfter: [] },
  });
  type Output = Assert<Equal<Awaited<ReturnType<typeof app[0]>>, Result<Execution<State>, ReplayInputError>>>;
  assert.deepEqual(await app[0]({ id: 'new', value: 1 }), ok({ kind: 'committed', value: { state: 'draft' } }));
  assert.deepEqual((await app[0].runDetailed({ id: 'history', value: 1 })).result, ok({ kind: 'replayed', value: { state: 'approved', by: 'boss' } }));
});

test('optional replay retains both public failure possibilities and selects the configured runtime', async () => {
  for (const enabled of [false, true]) {
    let lookups = 0;
    const replay = enabled ? { lookup: () => { lookups++; return err('LookupFailed' as const); }, resolveAfter: [] } : undefined;
    const app = business({ name: 'optional', load: async (n: number) => ok(n),
      operations: { go: [(n: number) => ok(n + 1)] },
      save: async (value: number) => ok({ kind: 'committed' as const, value }), replay });
    type Output = Assert<Equal<Awaited<ReturnType<typeof app.go>>, Result<{ kind: 'committed'; value: number }, never> | Result<Execution<number>, 'LookupFailed' | ReplayInputError>>>;
    assert.deepEqual(await app.go(1), enabled ? err('LookupFailed') : ok({ kind: 'committed', value: 2 }));
    assert.equal(lookups, enabled ? 1 : 0);
  }
});

if (false) {
  const identity = async <T>(value: T) => ok(value);
  // @ts-expect-error generic identity save cannot turn a number into an Execution envelope
  business({ name: 'unsafe', load: async (n: number) => ok(n), operations: { go: [(n: number) => ok(n)] }, save: identity, replay: { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: [] } });
}
