import test from 'node:test';
import assert from 'node:assert/strict';
import { err, type Result } from './framework/index.js';
import { procurement, procurementChanges } from './experiments/procurement/application.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { createRequest, checkOrder, placeOrder, placeCheckedOrder, amendOrder, cancelOrder, completeOrder, amendCheckedOrder, cancelCheckedOrder, completeCheckedOrder,
  type Actor, type Order, type Receipt, type Invoice, type RuleError, type Change } from './experiments/procurement/domain.js';
const buyer: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const policy = { requestLimitCents: 1000, approverIds: ['boss'] };
function fixture() {
  const created = createRequest({ input: { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 100 }] }, actor: buyer });
  assert(created.ok);
  const current: Order = { kind: 'order', state: 'placed', id: 'po', groupId: 'g1', version: 1, requestId: 'rq', ownerId: 'buyer', supplier: 'old', lines: created.value.result.lines, totalCents: 100 };
  return { input: { id: 'po', expectedVersion: 1, supplier: ' new ' }, actor: buyer, current, receipts: [] as Receipt[], invoices: [] as Invoice[] };
}
// The refusal table deliberately includes closed orders, beyond the placed fixture.
type Context = Omit<ReturnType<typeof fixture>, 'current'> & { current: Order };

test('order guard preserves refusal priority when several checks and operation-specific rules fail', () => {
  const cases: readonly [string, (value: Context) => Context, RuleError['kind']][] = [
    ['inactive', value => ({ ...value, actor: { ...buyer, active: false }, input: { ...value.input, id: 'wrong', expectedVersion: 0 } }), 'Denied'],
    ['owner', value => ({ ...value, actor: { ...buyer, id: 'stranger' } }), 'Denied'],
    ['role', value => ({ ...value, actor: { ...buyer, role: 'finance' } }), 'Denied'],
    ['target before version', value => ({ ...value, input: { ...value.input, id: 'wrong', expectedVersion: 0 } }), 'TargetMismatch'],
    ['related group', value => ({ ...value, invoices: [{ kind: 'invoice', state: 'registered', id: 'inv', orderId: 'po', groupId: 'other', version: 1, amountCents: 100 }] }), 'TargetMismatch'],
    ['invalid before closed', value => ({ ...value, input: { ...value.input, expectedVersion: 0 }, current: { ...value.current, state: 'cancelled' } }), 'InvalidInput'],
    ['stale before closed', value => ({ ...value, input: { ...value.input, expectedVersion: 99 }, current: { ...value.current, state: 'completed' } }), 'Conflict'],
    ['closed', value => ({ ...value, current: { ...value.current, state: 'cancelled' } }), 'WrongState'],
  ];
  for (const [name, change, kind] of cases) {
    const value = change(fixture()); value.input.supplier = '';
    for (const operation of [amendOrder, cancelOrder, completeOrder]) assert.deepEqual(operation(value), err({ kind }), name);
    assert.deepEqual(checkOrder(value), err({ kind }), name);
  }
});

test('proof-requiring order updates preserve context identity and independently specified write plans', () => {
  const value = fixture(), before = structuredClone(value), checked = checkOrder(value); assert(checked.ok);
  assert.strictEqual(checked.value, value);
  const check = { kind: 'order', id: 'po', groupId: 'g1', version: 1 };
  for (const [operation, ordinary, result] of [
    [amendCheckedOrder, amendOrder, { ...value.current, supplier: 'new', version: 2 }],
    [cancelCheckedOrder, cancelOrder, { ...value.current, state: 'cancelled' as const, version: 2 }],
  ] as const) {
    const expected = { ok: true, value: { result, writes: [result], checks: [check] } };
    assert.deepEqual(operation(checked.value), expected); assert.deepEqual(ordinary(value), expected);
  }
  assert.deepEqual(value, before);
  value.receipts.push({ kind: 'receipt', state: 'accepted', id: 'rc', groupId: 'g1', orderId: 'po', version: 1, quantities: [{ sku: 'a', quantity: 1 }] });
  value.invoices.push({ kind: 'invoice', state: 'matched', id: 'inv', groupId: 'g1', orderId: 'po', version: 2, amountCents: 100, receiptIds: ['rc'] });
  const ready = checkOrder(value); assert(ready.ok);
  const result = { ...value.current, state: 'completed', version: 2 };
  const expected = { ok: true, value: { result, writes: [result], checks: [check, { kind: 'invoice', id: 'inv', groupId: 'g1', version: 2 }] } };
  assert.deepEqual(completeCheckedOrder(ready.value), expected); assert.deepEqual(completeOrder(value), expected);
});

for (const backend of ['memory', 'sqlite']) test(`split order checks stop and save at the correct boundary: ${backend}`, async () => {
  const repository = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(':memory:', 'g1');
  let commits = 0, saveFailure = false;
  const tracked: ProcurementRepository = { read: repository.read.bind(repository), related: repository.related.bind(repository),
    commit: async (change, actor) => { commits++; return saveFailure ? err({ kind: 'Conflict' }) : repository.commit(change, actor); } };
  const commands = procurement(tracked, buyer, policy);
  try {
    assert((await commands.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 100 }] })).ok);
    assert((await commands.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'boss' })).ok);
    assert((await procurement(tracked, { ...buyer, id: 'boss', role: 'approver' }, policy).requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
    assert((await commands.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'old' })).ok);
    assert.equal(commits, 4);
    const denied = await procurement(tracked, { ...buyer, id: 'stranger' }, policy).orders.amend.runDetailed({ id: 'po', expectedVersion: 1, supplier: '' });
    assert.deepEqual(denied.result, err({ kind: 'Denied' })); assert.equal(denied.plan, null);
    assert.deepEqual(denied.trace.map(row => [row.step, row.status]), [['procurement.order.v1.amend:load', 'ok'], ['run:1', 'error']]);
    const invalid = await commands.orders.amend.runDetailed({ id: 'po', expectedVersion: 1, supplier: '' });
    assert.deepEqual(invalid.result, err({ kind: 'InvalidInput' })); assert.equal(invalid.plan, null);
    assert.deepEqual(invalid.trace.map(row => [row.step, row.status]), [['procurement.order.v1.amend:load', 'ok'], ['run:1', 'ok'], ['run:2', 'error']]);
    assert.equal(commits, 4);
    saveFailure = true;
    const failed = await commands.orders.amend.runDetailed({ id: 'po', expectedVersion: 1, supplier: 'new' });
    assert.deepEqual(failed.result, err({ kind: 'Conflict' })); assert(failed.plan);
    assert.deepEqual(failed.trace.map(row => row.status), ['ok', 'ok', 'ok', 'error']);
    const unchanged = await repository.read('order', 'po', buyer); assert(unchanged.ok); assert.equal(unchanged.value.version, 1);
    saveFailure = false;
    const amended = await commands.orders.amend({ id: 'po', expectedVersion: 1, supplier: ' new ' }); assert(amended.ok); assert.equal(amended.value.supplier, 'new');
    const cancelled = await commands.orders.cancel({ id: 'po', expectedVersion: 2 }); assert(cancelled.ok); assert.equal(cancelled.value.state, 'cancelled');
    assert.deepEqual(await commands.orders.complete({ id: 'po', expectedVersion: 3 }), err({ kind: 'WrongState' }));
    assert.equal(commits, 7);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts() {
  const value = fixture();
  // @ts-expect-error updating an order requires the private check proof
  amendCheckedOrder(value);
  // @ts-expect-error cancellation also requires successful shared validation
  cancelCheckedOrder(value);
  // @ts-expect-error completion cannot bypass shared validation
  completeCheckedOrder(value);
}
void typeContracts;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Value<R> = R extends { ok: true; value: infer T } ? T : never;
type Placed = Extract<Order, { state: 'placed' }>;
type Cancelled = Extract<Order, { state: 'cancelled' }>;
type Completed = Extract<Order, { state: 'completed' }>;
type ProducerContracts = [
  Assert<Equal<ReturnType<typeof placeOrder>, Result<Change<Placed>, RuleError>>>,
  Assert<Equal<ReturnType<typeof placeCheckedOrder>, Result<Change<Placed>, RuleError>>>,
  Assert<Equal<ReturnType<typeof amendOrder>, Result<Change<Placed>, RuleError>>>,
  Assert<Equal<ReturnType<typeof amendCheckedOrder>, Result<Change<Placed>, RuleError>>>,
  Assert<Equal<ReturnType<typeof cancelOrder>, Result<Change<Cancelled>, RuleError>>>,
  Assert<Equal<ReturnType<typeof cancelCheckedOrder>, Result<Change<Cancelled>, RuleError>>>,
  Assert<Equal<ReturnType<typeof completeOrder>, Result<Change<Completed>, RuleError>>>,
  Assert<Equal<ReturnType<typeof completeCheckedOrder>, Result<Change<Completed>, RuleError>>>,
];
function stateContracts(repository: SqliteProcurement, context: Context) {
  const checked = checkOrder(context);
  if (checked.ok) {
    const placed: 'placed' = checked.value.current.state;
    // @ts-expect-error a closed order cannot reuse the placed-state proof
    amendCheckedOrder({ ...checked.value, current: { ...checked.value.current, state: 'cancelled' } });
  }
  const commands = procurement(repository, buyer, policy);
  type Success<F extends (...args: never[]) => unknown> = Value<Awaited<ReturnType<F>>>;
  type PublicContracts = [
    Assert<Equal<Success<typeof commands.orders.place>, Placed>>,
    Assert<Equal<Success<typeof commands.orders.amend>, Placed>>,
    Assert<Equal<Success<typeof commands.orders.cancel>, Cancelled>>,
    Assert<Equal<Success<typeof commands.orders.complete>, Completed>>,
  ];
  const detailed = procurementChanges(repository, buyer, policy);
  type Detail = Assert<Equal<Success<typeof detailed.orders.complete>['result'], Completed>>;
  const replay = procurementReplay(repository, buyer, policy);
  type History = Success<typeof replay.orders.complete.run> extends { value: { result: infer T } } ? T : never;
  type Historical = Assert<Equal<History, Order>>;
}
