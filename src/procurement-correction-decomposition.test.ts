// Compare the retained compatibility, concrete Workflow and direct rule compositions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { business, describeFlow, err, ok, withInput, workflow, type Result } from './framework/index.js';
import { checkReceipt, createRequest, receiveOrder, receiptCorrectionInput, finishReceiptCorrection, correctCheckedReceipt, type Actor, type CheckedReceipt, type Change, type CorrectInput, type ReceivedChange, type Order, type Receipt, type RuleError, type Stock } from './experiments/procurement/domain.js';
import { correctedQuantities, correctionPlan } from './experiments/procurement/receipt-pipeline.js';
import { includeChangedStock, type ReceiptStockContext } from './experiments/procurement/inventory.js';
type Context = CheckedReceipt<ReceiptStockContext<CorrectInput>>;
const quantities = withInput((context: Context) => receiveOrder(receiptCorrectionInput(context)));
// Retain the old annotated flat composition as a comparison, not the live API.
const finishFlat = ({ input, value }: Readonly<{ input: Context; value: ReceivedChange }>) => ok({ input, value: finishReceiptCorrection(input, value) });
const nested = workflow('revalidate-correction', (value: Context) => correctedQuantities(value))
  .then('correct-receipt-plan', pair => correctionPlan(pair));
// Keep the pre-migration compatibility boundary as an explicit comparison.
const legacyDecision = withInput((context: Context) => correctCheckedReceipt(context));

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
  const exposed = business({ name: 'probe.exposed', load, save, operations: { correct: [checkReceipt, nested, includeChangedStock] } });
  const direct = business({ name: 'probe.direct', load, save, operations: { correct: [checkReceipt,
    { name: 'revalidate-correction', rule: correctedQuantities },
    { name: 'correct-receipt-plan', rule: correctionPlan },
    { name: 'run:3', rule: includeChangedStock }] } });
  const legacy = business({ name: 'probe.legacy', load, save, operations: { correct: [checkReceipt, legacyDecision, includeChangedStock] } });
  return { flat: flat.correct, nested: composed.correct, legacy: legacy.correct, exposed: exposed.correct, direct: direct.correct, saves: () => saves };
}

test('flat and nested correction probes preserve the current plan and keep original input immutable', async () => {
  const context = fixture(), before = structuredClone(context), commands = candidates(context);
  const reports = await Promise.all([commands.legacy.runDetailed(context.input), commands.flat.runDetailed(context.input), commands.nested.runDetailed(context.input), commands.exposed.runDetailed(context.input), commands.direct.runDetailed(context.input)]);
  assert.equal(commands.saves(), 5);
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
  for (const name of ['legacy', 'flat', 'nested', 'exposed', 'direct'] as const) {
    const commands = candidates(context), report = await commands[name].runDetailed(context.input);
    assert.deepEqual(report.result, err({ kind: 'InsufficientStock' })); assert.equal(report.plan, null); assert.equal(commands.saves(), 0);
    assert.deepEqual(report.trace.map(row => row.status), name === 'flat' || name === 'exposed' || name === 'direct' ? ['ok', 'ok', 'ok', 'ok', 'error'] : ['ok', 'ok', 'ok', 'error']);
  }
  assert.deepEqual(context, before);
});

test('correction probes keep check and quantity failures before finish, stock and save', async () => {
  const context = fixture();
  for (const name of ['legacy', 'flat', 'nested', 'exposed', 'direct'] as const) {
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
  const exposed = await commands.exposed.runDetailed(context.input, { input: (_value, step) => step, result: result => result.ok });
  assert.deepEqual(exposed.trace.map(row => row.step), ['probe.exposed.correct:load', 'run:1', 'revalidate-correction', 'correct-receipt-plan', 'run:3', 'probe.exposed.correct']);
  assert.deepEqual(exposed.observations.map(row => row.step), exposed.trace.map(row => row.step));
  const explicit = JSON.stringify(describeFlow(commands.exposed));
  assert(explicit.includes('revalidate-correction') && explicit.includes('correct-receipt-plan'));
  const inner = JSON.stringify(describeFlow(nested)), outer = JSON.stringify(describeFlow(commands.nested));
  assert(inner.includes('revalidate-correction') && inner.includes('correct-receipt-plan'));
  assert(!outer.includes('revalidate-correction') && !outer.includes('correct-receipt-plan'));
  const direct = await commands.direct.runDetailed(context.input, { input: (_value, step) => step, result: result => result.ok });
  assert.deepEqual(direct.trace.map(row => row.step), ['probe.direct.correct:load', 'run:1', 'revalidate-correction', 'correct-receipt-plan', 'run:3', 'probe.direct.correct']);
  assert.deepEqual(direct.observations.map(row => row.step), direct.trace.map(row => row.step));
  const live = JSON.stringify(describeFlow(commands.direct));
  assert(live.includes('revalidate-correction') && live.includes('correct-receipt-plan'));
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
  // @ts-expect-error the direct declaration still requires quantities
  commands.direct({ id: 'rc', expectedVersion: 1 });
  // @ts-expect-error raw context cannot skip the check in the direct rule either
  correctedQuantities(context);
  // @ts-expect-error finishing requires a validated quantities result
  if (checked.ok) correctionPlan(checked.value);
}
void typeContracts;
