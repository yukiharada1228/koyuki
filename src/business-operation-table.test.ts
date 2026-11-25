import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { business, ok, type Result, type Execution, type GroupExecution } from './framework/index.js';
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
function contracts() {
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
