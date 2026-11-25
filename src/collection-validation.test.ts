import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEach, workflow, ok, err, type Result } from './framework/index.js';
import { orderLinesOperation, validateLine, priceLines, type Line, type LineError } from './examples/order-lines.js';
import { business } from './experiments/business.js';

test('collection validation gathers every independent failure with its original position', () => {
  const visited: number[] = [], defect = { kind: 'Invalid' as const };
  const validate = collectEach((value: number): Result<string, typeof defect> => {
    visited.push(value); return value < 0 ? err(defect) : ok(String(value));
  });
  const input = [1, -2, 3, -4];
  assert.deepEqual(visited, []);
  const result = validate(input);
  assert.deepEqual(result, err([{ index: 1, error: defect }, { index: 3, error: defect }]));
  assert.deepEqual(visited, input); assert.deepEqual(input, [1, -2, 3, -4]);
  assert(!Object.isFrozen(input)); assert(!Object.isFrozen(defect));
  assert(!result.ok); assert(Object.isFrozen(result.error)); assert(Object.isFrozen(result.error[0]));
  assert.equal(result.error[0]?.error, defect);
});

test('successful collections preserve order and value identity, including an empty collection', () => {
  const first = { id: 'a' }, second = { id: 'b' };
  const validate = collectEach((item: typeof first) => ok(item));
  const result = validate([first, second]); assert(result.ok);
  assert.deepEqual(result.value, [first, second]); assert(Object.isFrozen(result.value));
  assert.equal(result.value[0], first); assert(!Object.isFrozen(first));
  assert.deepEqual(validate([]), ok([]));
});

test('the helper snapshots collection positions and preserves thrown defects', () => {
  const items = [1, 2, 3];
  const validate = collectEach((n: number) => { if (n === 1) items.splice(1); return ok(n); });
  assert.deepEqual(validate(items), ok([1, 2, 3]));
  const defect = new Error('programming defect');
  let calls = 0;
  const broken = collectEach((n: number) => { calls++; if (n === 2) throw defect; return ok(n); });
  assert.throws(() => broken([1, 2, 3]), error => error === defect); assert.equal(calls, 2);
});

const valid: Line = { sku: ' item ', quantity: 2, unitPriceYen: 500 };
test('an invalid order gathers line issues before stopping aggregate calculation and persistence', async () => {
  let writes = 0;
  const operation = orderLinesOperation(async quote => { writes++; return ok(quote.totalYen); });
  const input = [valid, { ...valid, quantity: 0 }, { ...valid, sku: '' }, { ...valid, unitPriceYen: -1 }];
  const before = structuredClone(input), report = await operation.runDetailed(input);
  assert.deepEqual(report.result, err([{ index: 1, error: { kind: 'InvalidQuantity' } }, { index: 2, error: { kind: 'InvalidSku' } }, { index: 3, error: { kind: 'InvalidUnitPrice' } }]));
  assert.deepEqual(report.trace, [{ step: 'order-lines.quote.v1:load', status: 'ok' }, { step: 'validate', status: 'error' }]);
  assert.equal(report.plan, null); assert.equal(writes, 0); assert.deepEqual(input, before);
});

test('valid order lines price and save once; empty and overflowing orders stop before save', async () => {
  let writes = 0;
  const operation = orderLinesOperation(async quote => { writes++; return ok({ totalYen: quote.totalYen, skus: quote.lines.map(line => line.sku) }); });
  assert.deepEqual(await operation.run([valid, { ...valid, quantity: 1 }]), ok({ totalYen: 1500, skus: ['item', 'item'] }));
  assert.equal(writes, 1);
  assert.deepEqual(await operation.run([]), err({ kind: 'EmptyOrder' }));
  const maximum = { ...valid, quantity: 1, unitPriceYen: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(await operation.run([maximum, maximum]), err({ kind: 'OrderTotalOverflow' }));
  assert.deepEqual(await operation.run([{ ...maximum, quantity: 2 }]), err([{ index: 0, error: { kind: 'LineTotalOverflow' } }]));
  assert.equal(writes, 1);
});

test('collection rules also connect to the ordinary-function business API', async () => {
  let writes = 0;
  const validateLines = collectEach(validateLine);
  const commands = business({ name: 'lines', load: async (input: readonly Line[]) => ok(input),
    save: async (quote: import('./examples/order-lines.js').Quote) => { writes++; return ok(quote.totalYen); },
    operations: { price: [validateLines, priceLines] },
  });
  assert.deepEqual(await commands.price([valid]), ok(1000));
  assert.deepEqual(await commands.price([{ ...valid, quantity: 0 }]), err([{ index: 0, error: { kind: 'InvalidQuantity' } }]));
  assert.equal(writes, 1);
});

function contracts() {
  const validate = collectEach(validateLine);
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  type Assert<T extends true> = T;
  type Exact = Assert<Equal<ReturnType<typeof validate>, Result<readonly import('./examples/order-lines.js').ValidatedLine[], readonly { readonly index: number; readonly error: LineError }[]>>>;
  const exact: Result<readonly import('./examples/order-lines.js').ValidatedLine[], readonly { readonly index: number; readonly error: LineError }[]> = validate([valid]); void exact;
  workflow('lines', validate).then('price', priceLines);
  // @ts-expect-error collection input retains the element's input contract
  validate([{ sku: 'x' }]);
  // @ts-expect-error validation produces a collection, not a single validated line
  workflow('lines', validate).then('wrong', validateLine);
  // @ts-expect-error async effects do not belong to independent pure validations
  collectEach(async (n: number) => ok(n));
  // @ts-expect-error input without validation does not carry the private line proof
  priceLines([valid]);
}
void contracts;
