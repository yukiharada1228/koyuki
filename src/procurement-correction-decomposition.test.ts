// Design probe: duplicate the small correction-plan projection explicitly rather
// than change the live domain API before comparing the composition trade-off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { business, describeFlow, err, ok, withInput, workflow, type Result } from './framework/index.js';
import { checkReceipt, createRequest, receiveOrder, type Actor, type CheckedReceipt, type Change, type CorrectInput, type Invoice, type Order, type Receipt, type RuleError, type Stock } from './experiments/procurement/domain.js';
import { correctDecision } from './experiments/procurement/receipt-pipeline.js';
import { includeChangedStock, type ReceiptDecision, type ReceiptStockContext } from './experiments/procurement/inventory.js';
type Context = CheckedReceipt<ReceiptStockContext<CorrectInput>>;
const quantities = withInput((context: Context) => receiveOrder({
  input: { id: context.order.id, expectedVersion: context.order.version, receiptId: context.current.id, quantities: context.input.quantities },
  actor: context.actor, current: context.order, receipts: context.receipts.filter(row => row.id !== context.current.id),
}));
// This is a candidate ordinary domain projection, not a new public framework API.
function finish(input: Context, received: Change<Receipt>): Change<Receipt> {
  const result: Receipt = { ...received.result, version: input.current.version + 1 };
  const reset: Invoice[] = input.invoices.filter(row => row.state === 'matched').map(row => ({
    kind: 'invoice', state: 'registered', id: row.id, groupId: row.groupId, orderId: row.orderId, amountCents: row.amountCents, version: row.version + 1,
  }));
  const check = (row: Receipt | Order | Invoice) => ({ kind: row.kind, id: row.id, groupId: row.groupId, version: row.version });
  return { result, checks: [check(input.current), check(input.order), ...input.invoices.map(check)], writes: [{ ...input.order, version: input.order.version + 1 }, result, ...reset] };
}
// Flat composition needs a second contextual annotation for this callback.
const finishFlat = ({ input, value }: ReceiptDecision<Context>) => ok({ input, value: finish(input, value) });
// Workflow.then supplies that context without a callback annotation. Its run
// function is deliberately an opaque function when passed into business.
const nested = workflow('revalidate-correction', quantities)
  .then('finish-correction', ({ input, value }) => ok({ input, value: finish(input, value) }));

function fixture(): ReceiptStockContext<CorrectInput> {
  const actor: Actor = { id: 'worker', groupId: 'g1', role: 'warehouse', active: true };
  const request = createRequest({ input: { id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 100 }] }, actor: { ...actor, id: 'buyer', role: 'buyer' } }); assert(request.ok);
  const order: Order = { kind: 'order', state: 'placed', id: 'po', groupId: 'g1', version: 2, requestId: 'rq', ownerId: 'buyer', supplier: 'supplier', totalCents: 200, lines: request.value.result.lines };
  const current: Receipt = { kind: 'receipt', state: 'accepted', id: 'rc', groupId: 'g1', version: 1, orderId: 'po', quantities: [{ sku: 'a', quantity: 1 }] };
  const stock: Stock = { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1, positions: [{ sku: 'a', location: 'receiving', onHand: 1, reserved: 0 }], lastAdjustment: null };
  return { input: { id: 'rc', expectedVersion: 1, quantities: [{ sku: 'a', quantity: 2 }] }, actor, order, current, receipts: [current], invoices: [], stock };
}

function candidates(context: ReceiptStockContext<CorrectInput>) {
  let saves = 0;
  const load = async (input: CorrectInput) => ok({ ...context, input });
  const save = async (change: Change<Receipt>): Promise<Result<Receipt, 'SaveUnavailable'>> => { saves++; return ok(change.result); };
  const flat = business({ name: 'probe.flat', load, save, operations: { correct: [checkReceipt, quantities, finishFlat, includeChangedStock] } });
  const composed = business({ name: 'probe.nested', load, save, operations: { correct: [checkReceipt, nested.run, includeChangedStock] } });
  const current = business({ name: 'probe.current', load, save, operations: { correct: [checkReceipt, correctDecision, includeChangedStock] } });
  return { flat: flat.correct, nested: composed.correct, current: current.correct, saves: () => saves };
}

test('flat and nested correction probes preserve the current plan and keep original input immutable', async () => {
  const context = fixture(), before = structuredClone(context), commands = candidates(context);
  const reports = await Promise.all([commands.current.runDetailed(context.input), commands.flat.runDetailed(context.input), commands.nested.runDetailed(context.input)]);
  assert.equal(commands.saves(), 3);
  const receipt: Receipt = { ...context.current, version: 2, quantities: [{ sku: 'a', quantity: 2 }] };
  assert(context.stock);
  const stock: Stock = { ...context.stock, version: 2, positions: [{ sku: 'a', location: 'receiving', onHand: 2, reserved: 0 }] };
  const expected = { result: receipt, writes: [{ ...context.order, version: 3 }, receipt, stock], checks: [
    { kind: 'receipt', id: 'rc', groupId: 'g1', version: 1 }, { kind: 'order', id: 'po', groupId: 'g1', version: 2 }, { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1 },
  ] };
  for (const report of reports) {
    assert.deepEqual(report.result, ok(receipt));
    assert(report.plan && typeof report.plan === 'object' && 'input' in report.plan);
    assert.deepEqual(report.plan.input, expected);
  }
  assert.deepEqual(context, before);
});

test('a planned correction rejected by stock is never saved by either composition', async () => {
  const base = fixture(); assert(base.stock);
  const current: Receipt = { ...base.current, quantities: [{ sku: 'a', quantity: 2 }] };
  const context = { ...base, current, receipts: [current], input: { ...base.input, quantities: [{ sku: 'a', quantity: 1 }] },
    stock: { ...base.stock, positions: [{ sku: 'a', location: 'receiving', onHand: 2, reserved: 2 }] } };
  const before = structuredClone(context);
  for (const name of ['current', 'flat', 'nested'] as const) {
    const commands = candidates(context), report = await commands[name].runDetailed(context.input);
    assert.deepEqual(report.result, err({ kind: 'InsufficientStock' })); assert.equal(report.plan, null); assert.equal(commands.saves(), 0);
    assert.deepEqual(report.trace.map(row => row.status), name === 'flat' ? ['ok', 'ok', 'ok', 'ok', 'error'] : ['ok', 'ok', 'ok', 'error']);
  }
  assert.deepEqual(context, before);
});

test('correction probes keep check and quantity failures before finish, stock and save', async () => {
  const context = fixture();
  for (const name of ['current', 'flat', 'nested'] as const) {
    const commands = candidates(context), command = commands[name];
    const check = await command.runDetailed({ ...context.input, expectedVersion: -1 });
    assert.deepEqual(check.result, err({ kind: 'InvalidInput' })); assert.equal(check.trace.length, 2); assert.equal(check.plan, null);
    const quantity = await command.runDetailed({ ...context.input, quantities: [{ sku: 'a', quantity: 3 }] });
    assert.deepEqual(quantity.result, err({ kind: 'QuantityExceeded' })); assert.equal(quantity.trace.length, 3); assert.equal(quantity.plan, null);
    assert.equal(commands.saves(), 0);
  }
});

test('flat business exposes four rules while a composed Workflow run keeps its inner steps opaque', async () => {
  const context = fixture(), commands = candidates(context);
  const flat = await commands.flat.runDetailed(context.input), composed = await commands.nested.runDetailed(context.input);
  assert.deepEqual(flat.trace.map(row => row.step), ['probe.flat.correct:load', 'run:1', 'run:2', 'run:3', 'run:4', 'probe.flat.correct']);
  assert.deepEqual(composed.trace.map(row => row.step), ['probe.nested.correct:load', 'run:1', 'run:2', 'run:3', 'probe.nested.correct']);
  const inner = JSON.stringify(describeFlow(nested)), outer = JSON.stringify(describeFlow(commands.nested));
  assert(inner.includes('revalidate-correction') && inner.includes('finish-correction'));
  assert(!outer.includes('revalidate-correction') && !outer.includes('finish-correction'));
});

function typeContracts() {
  const context = fixture(), checked = checkReceipt(context);
  if (checked.ok) { quantities(checked.value); nested.run(checked.value); }
  // @ts-expect-error raw context cannot skip the receipt check
  quantities(context);
  // @ts-expect-error a successful receipt decision is required, not just the checked context
  if (checked.ok) finishFlat(checked.value);
  const commands = candidates(context);
  const result: Promise<Result<Receipt, RuleError | 'SaveUnavailable'>> = commands.flat(context.input);
  void result;
  // @ts-expect-error a correction requires quantities
  commands.flat({ id: 'rc', expectedVersion: 1 });
}
void typeContracts;
