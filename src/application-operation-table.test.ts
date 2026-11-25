import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operations, replayOperations, ok, err, type Result, type ApplicationEvent, type ApplicationState } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const command = { run: async (n: number): Promise<Result<number, 'Negative'>> => n < 0 ? err('Negative') : ok(n) };
const reduce = (_: number, n: number) => n;
const entry = { ...command, reduce };

for (const mode of ['direct', 'normal', 'replay'] as const) test(`non-enumerable own operations participate in Application (${mode})`, async () => {
  const source = mode === 'direct' ? entry : mode === 'normal' ? command : { run: async (n: number) => ok({ kind: 'committed' as const, value: n }) };
  const table = Object.defineProperty({ go: source }, 'go', { enumerable: false });
  const registered = mode === 'direct' ? table as { go: typeof entry }
    : mode === 'normal' ? operations(table as { go: typeof command }, reduce)
    : replayOperations(table as { go: { run(n: number): Promise<Result<{ kind: 'committed'; value: number }, never>> } }, reduce);
  const session = await defineApplication({ initial: () => 0, operations: registered, view: state => state.data }).start();
  assert((await session.dispatch({ type: 'go', input: 7 })).ok);
  assert.equal(session.snapshot().view, 7);
});

test('numeric operation names remain correlated with input and failure types as runtime strings', async () => {
  const table = operations({ 0: command, other: { run: async (s: string) => ok(s.length) } }, reduce);
  type Event = Assert<Equal<ApplicationEvent<typeof table>, { readonly type: '0'; readonly input: number } | { readonly type: 'other'; readonly input: string } | { readonly type: 'dismiss' }>>;
  type Failed = Extract<ApplicationState<number, typeof table>, { kind: 'failed'; operation: '0' }>;
  type Error = Assert<Equal<Failed['error'], 'Negative'>>;
  const session = await defineApplication({ initial: () => 0, operations: table, view: s => s.data }).start();
  assert((await session.dispatch({ type: '0', input: 3 })).ok); assert.equal(session.snapshot().view, 3);
  const failed = await session.dispatch({ type: '0', input: -1 });
  assert(failed.ok && failed.value.state.kind === 'failed'); assert.equal(failed.value.state.operation, '0'); assert.equal(failed.value.state.error, 'Negative');
  if (false) {
    // @ts-expect-error event tags are JavaScript property strings
    session.dispatch({ type: 0, input: 2 });
    // @ts-expect-error numeric operation still requires its own numeric input
    session.dispatch({ type: '0', input: 'wrong' });
  }
});

test('registration validates the whole operation table before invoking command getters', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'go', { get() { reads++; return entry; } });
  const symbol = { [Symbol('go')]: entry };
  const inherited = Object.create({ go: entry });
  for (const table of [getter, symbol, inherited]) {
    assert.throws(() => defineApplication({ initial: () => 0, operations: table, view: s => s.data }), /OperationTableRequires/);
    assert.throws(() => Reflect.apply(operations, undefined, [table, reduce]), /OperationTableRequires/);
    assert.throws(() => Reflect.apply(replayOperations, undefined, [table, reduce]), /OperationTableRequires/);
  }
  assert.equal(reads, 0);
});

test('hidden reserved names are rejected and null-prototype records retain prototype-like names safely', async () => {
  for (const name of ['dismiss', '@complete']) {
    const table = Object.defineProperty({}, name, { value: entry });
    assert.throws(() => defineApplication({ initial: () => 0, operations: table, view: s => s.data }), /ReservedOperationName/);
  }
  const table = { ['__proto__']: entry, constructor: entry };
  Object.setPrototypeOf(table, null);
  const session = await defineApplication({ initial: () => 0, operations: table, view: s => s.data }).start();
  assert((await session.dispatch({ type: '__proto__', input: 9 })).ok); assert.equal(session.snapshot().view, 9);
  assert((await session.dispatch({ type: 'constructor', input: 10 })).ok); assert.equal(session.snapshot().view, 10);
});
