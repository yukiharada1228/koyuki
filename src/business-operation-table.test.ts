import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { business, ok, err, workflow, process as effectProcess, type Result, type Execution, type GroupExecution } from './framework/index.js';
const rule = (n: number) => ok(n + 1);
const load = async (n: number) => ok(n);
const save = async (n: number) => ok(n);
// Exercise the JavaScript boundary without pretending malformed tables satisfy the public declaration.
function unchecked(operations: unknown, operation = (name: string) => name): unknown {
  return Reflect.apply(business, undefined, [{ name: 'table', load, save, operation, operations }]);
}
test('non-enumerable own operation data is registered rather than silently omitted', async () => {
  const operations = { hidden: [rule] as const };
  Object.defineProperty(operations, 'hidden', { enumerable: false });
  const commands = business({ name: 'hidden', load, save, operations });
  assert.deepEqual(Object.keys(operations), []); assert.deepEqual(Object.keys(commands), ['hidden']);
  assert.deepEqual(await commands.hidden(2), ok(3)); assert(Object.isFrozen(commands));
  assert.equal(Object.getOwnPropertyDescriptor(operations, 'hidden')?.enumerable, false);
});
test('Symbol declarations are rejected before any operation resolver runs', () => {
  let calls = 0;
  const operations = { good: [rule], [Symbol('unsupported')]: [rule] };
  assert.throws(() => unchecked(operations, () => { calls++; return 'id'; }), /BusinessOperationsRequireStringDataKeys/);
  assert.equal(calls, 0);
});
test('operation accessors are rejected without invoking their getters', () => {
  let reads = 0;
  const operations = { get hidden() { reads++; return [rule]; } };
  assert.throws(() => unchecked(operations), /BusinessOperationsRequireStringDataKeys/); assert.equal(reads, 0);
});
test('inherited operation tables fail at construction instead of producing phantom commands', () => {
  let reads = 0;
  class Operations { get hidden() { reads++; return [rule]; } }
  assert.throws(() => unchecked(new Operations()), /BusinessOperationsRequirePlainRecord/); assert.equal(reads, 0);
  assert.throws(() => unchecked(Object.create({ hidden: [rule] })), /BusinessOperationsRequirePlainRecord/);
});
test('null-prototype and cross-realm native records remain supported', async () => {
  for (const prototype of [null, runInNewContext('Object.prototype')]) {
    const operations = { go: [rule] as const }; Object.setPrototypeOf(operations, prototype);
    const commands = business({ name: 'realm', load, save, operations });
    assert.deepEqual(await commands.go(2), ok(3)); assert.equal(Object.getPrototypeOf(operations), prototype);
  }
});
test('numeric operation names match the actual string names in resolver and save context', async () => {
  const resolved: string[] = [], saved: string[] = [];
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  const commands = business({ name: 'numbers', load,
    operation: name => { const exact: Equal<typeof name, '0' | '2.5' | 'named'> = true; void exact; resolved.push(name); return `numbers.${name}`; },
    save: async (n: number, context) => { const exact: Equal<typeof context.name, '0' | '2.5' | 'named'> = true; void exact; saved.push(context.name); return ok(n); },
    operations: { 0: [rule], 2.5: [rule], named: [rule] } });
  assert.deepEqual(await commands[0](1), ok(2)); assert.deepEqual(await commands[2.5](2), ok(3)); assert.deepEqual(await commands.named(3), ok(4));
  assert.deepEqual(resolved, ['0', '2.5', 'named']); assert.deepEqual(saved, ['0', '2.5', 'named']);
});
test('a broad numeric dictionary uses string context names, including non-finite numeric keys', async () => {
  const operations: Record<number, readonly [(n: number) => Result<number, never>]> = { [Infinity]: [rule] };
  let observed: string | undefined;
  const commands = business({ name: 'dictionary', load, operations, save: async (n: number, context) => {
    const name: string = context.name; observed = name; return ok(n);
  } });
  const command = commands[Infinity]; assert(command); assert.deepEqual(await command(2), ok(3)); assert.equal(observed, 'Infinity');
});
test('numeric replay operations use the same literal string name in lookup and save', async () => {
  const seen: string[] = [];
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  const savePort = async (n: number, context: GroupExecution<'0', number>): Promise<Result<Execution<number>, never>> => {
    seen.push(`save:${context.name}`); return ok({ kind: 'committed', value: n });
  };
  const commands = business({ name: 'replay-numeric', load, operations: { 0: [rule] },
    save: savePort,
    replay: { lookup: context => {
      const exact: Equal<typeof context.name, '0'> = true; void exact; seen.push(`lookup:${context.name}`);
      return ok({ kind: 'missing' as const });
    }, resolveAfter: [] },
  });
  assert.deepEqual(await commands[0](2), ok({ kind: 'committed', value: 3 })); assert.deepEqual(seen, ['lookup:0', 'save:0']);
});
test('own prototype-like names remain data keys without changing the command object prototype', async () => {
  const commands = business({ name: 'keys', load, save, operations: { ['__proto__']: [rule], constructor: [rule] } });
  assert.deepEqual(await commands.__proto__(1), ok(2)); assert.deepEqual(await commands.constructor(2), ok(3));
  assert.equal(Object.getPrototypeOf(commands), Object.prototype);
});
test('the complete table is checked before resolving an earlier valid operation', () => {
  let calls = 0;
  assert.throws(() => unchecked({ good: [rule], then: [rule] }, () => { calls++; return 'id'; }), /ReservedBusinessOperation:then/);
  assert.equal(calls, 0);
});
test('operations with their own ordinary and detailed loaders need no shared loader', async () => {
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  const seen: string[] = [];
  const commands = business({ name: 'local', save: async <T extends { value: number | string }>(value: T) => { seen.push('save'); return ok(value); }, operations: {
    number: { load: async (input: { n: number }): Promise<Result<number, 'MissingNumber'>> => { seen.push('number'); return input.n < 0 ? err('MissingNumber') : ok(input.n); }, run: [(n: number) => ok({ value: n + 1 })] },
    text: { load: effectProcess<{ text: string }>().through(workflow('length', input => ok(input.text.length))), run: [(n: number) => ok({ value: String(n) })] },
  } });
  const input: Equal<Parameters<typeof commands.number>[0], { n: number }> = true;
  const output: Equal<Awaited<ReturnType<typeof commands.number>>, Result<{ value: number }, 'MissingNumber'>> = true;
  const text: Equal<Awaited<ReturnType<typeof commands.text>>, Result<{ value: string }, never>> = true;
  void input; void output; void text;
  assert.deepEqual(await commands.number({ n: 2 }), ok({ value: 3 }));
  const detail = await commands.text.runDetailed({ text: 'abc' }, { input: () => null, result: result => result.ok });
  assert.deepEqual(detail.result, ok({ value: '3' })); assert(detail.observations.length > 0);
  assert.deepEqual(await commands.number({ n: -1 }), err('MissingNumber'));
  assert.deepEqual(seen, ['number', 'save', 'save', 'number']);
});
test('replay without a shared loader preserves request context and bypasses a cached operation', async () => {
  let loaded = 0, saved = 0;
  let receipt: { kind: 'missing' } | { kind: 'found'; value: number } = { kind: 'missing' };
  const commands = business({ name: 'own-replay', operations: {
    0: { load: async (input: { n: number }) => { loaded++; return ok(input.n); }, run: [rule] },
  }, save: async (n: number, context): Promise<Result<Execution<number>, never>> => {
    const name: '0' = context.name; const input: { n: number } = context.request; void name; void input;
    saved++; receipt = { kind: 'found', value: n }; return ok({ kind: 'committed', value: n });
  }, replay: { lookup: context => {
    const name: '0' = context.name; const input: { n: number } = context.request; void name; void input;
    return ok(receipt);
  }, resolveAfter: [] } });
  assert.deepEqual(await commands[0]({ n: 2 }), ok({ kind: 'committed', value: 3 }));
  assert.deepEqual(await commands[0]({ n: 2 }), ok({ kind: 'replayed', value: 3 }));
  assert.equal(loaded, 1); assert.equal(saved, 1);
});
test('unused shared load is not read and untyped missing shared load fails before resolver callbacks', async () => {
  let reads = 0, resolved = 0;
  const commands = business({ name: 'unused', get load(): typeof load { reads++; throw Error('Unused'); }, save,
    operations: { go: { load, run: [rule] } } });
  assert.deepEqual(await commands.go(1), ok(2)); assert.equal(reads, 0);
  assert.throws(() => Reflect.apply(business, undefined, [{ name: 'missing', save, operation: () => { resolved++; return 'id'; }, operations: { go: [rule] } }]), /BusinessRequiresSharedLoad/);
  assert.equal(resolved, 0);
});
function contracts() {
  // @ts-expect-error an operation tuple still needs a shared loader
  business({ name: 'missing', save, operations: { go: [rule] } });
  // @ts-expect-error one local loader cannot provide the loader for another operation tuple
  business({ name: 'mixed', save, operations: { own: { load, run: [rule] }, other: [rule] } });
  // @ts-expect-error even a pipeline accepting unknown cannot omit its shared loader
  business({ name: 'unknown', save, operations: { go: [(_input: unknown) => ok(1)] } });
  // @ts-expect-error omitting the shared loader does not bypass stage input checks
  business({ name: 'bad-own', save, operations: { go: { load, run: [(text: string) => ok(text.length)] } } });
  const key = Symbol('operation');
  // @ts-expect-error symbols cannot name generated business operations
  business({ name: 'symbol', load, save, operations: { [key]: [rule] } });
  const wrongSave = async (n: number, _context: GroupExecution<'different', number>) => ok<Execution<number>>({ kind: 'committed', value: n });
  // @ts-expect-error a numeric operation cannot call a save port that only accepts a different name
  business({ name: 'wrong-context', load, save: wrongSave, operations: { 0: [rule] }, replay: { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: [] } });
  // @ts-expect-error resolver names are strings, not the original numeric key type
  business({ name: 'wrong-name', load, save, operation: (_name: 0) => 'id', operations: { 0: [rule] } });
}
void contracts;
