import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreOrder, validateShipping, selectService, type QuoteRequest, type ShippedOrder } from './shipping/domain.js';
import { expenseWorkflow, type ExpenseDecision, type ValidExpense, type ReceiptedExpense } from './examples/expense.js';
import { requireActive, requireArchived, checkRestoreCapacity, type LifecycleCommand, type ActiveTag, type ArchivedTag } from './tags/lifecycle.js';
import { restoreTag } from './tags/domain.js';
const rawOrder = { id: 'o1', version: 1, totalYen: 10000 };
function validRequest(country: 'JP' | 'US') {
  const result = validateShipping({ orderId: 'o1', country, weightGrams: 100 }); assert(result.ok); return result.value;
}
test('order restoration validates persistence data and returns one exact variant', () => {
  for (const status of ['open', 'shipped'] as const) {
    const raw = { ...rawOrder, status }, result = restoreOrder(raw); assert(result.ok);
    assert.equal(result.value.status, status); assert(Object.isFrozen(result.value));
    raw.version = 99; assert.equal(result.value.version, 1);
  }
  for (const raw of [null, {}, { ...rawOrder, status: 'unknown' }, { ...rawOrder, status: 'open', version: 0 },
    { ...rawOrder, status: 'open', totalYen: NaN }, { ...rawOrder, status: 'open', id: '' }]) {
    assert.deepEqual(restoreOrder(raw), { ok: false, error: { kind: 'CorruptOrder' } });
  }
});
test('shipping accepts an open order and rejects shipped orders before quotation', () => {
  const shipped = restoreOrder({ ...rawOrder, status: 'shipped' }); assert(shipped.ok);
  assert.deepEqual(selectService({ request: validRequest('JP'), order: shipped.value }), { ok: false, error: { kind: 'OrderClosed' } });
  for (const country of ['JP', 'US'] as const) {
    const open = restoreOrder({ ...rawOrder, status: 'open' }); assert(open.ok);
    const quote = selectService({ request: validRequest(country), order: open.value }); assert(quote.ok);
    assert.equal(quote.value.order.status, 'open');
    if (quote.value.service === 'domestic') {
      const country: 'JP' = quote.value.request.country; assert.equal(country, 'JP');
    } else { const country: 'US' = quote.value.request.country; assert.equal(country, 'US'); }
  }
});
test('expense approval variants retain active-employee and receipt proofs', () => {
  for (const amount of [3001, 100001]) {
    const decision = expenseWorkflow.run({ id: 'e', amount, receipt: true, employeeActive: true }); assert(decision.ok);
    assert.notEqual(decision.value.route, 'automatic');
    if (decision.value.route !== 'automatic') {
      const receipt: true = decision.value.expense.receipt;
      const active: true = decision.value.expense.employeeActive;
      assert.equal(receipt, true); assert.equal(active, true);
    }
  }
  const automatic = expenseWorkflow.run({ id: 'e', amount: 100, receipt: false, employeeActive: true });
  assert(automatic.ok && automatic.value.route === 'automatic'); assert.equal(automatic.value.expense.receipt, false);
});
test('lifecycle narrows to one state and capacity proof preserves archived state', () => {
  const tag = restoreTag({ id: 't', groupId: 'g', label: 'A', icon: null, sortOrder: 0, version: 1 }); assert(tag.ok);
  const context = { current: tag.value, activeCount: 1, max: 3 };
  const active = requireActive({ kind: 'active', ...context }); assert(active.ok);
  const activeKind: 'active' = active.value.kind; assert.equal(activeKind, 'active');
  assert.deepEqual(requireArchived(active.value), { ok: false, error: { kind: 'NotArchived' } });
  const archived = requireArchived({ kind: 'archived', ...context }); assert(archived.ok);
  assert.deepEqual(requireActive(archived.value), { ok: false, error: { kind: 'AlreadyArchived' } });
  const allowed = checkRestoreCapacity(archived.value); assert(allowed.ok);
  const archivedKind: 'archived' = allowed.value.kind; assert.equal(archivedKind, 'archived');
});
// Compile-time checks target forbidden cross-state combinations, without casts.
function forbidden(quote: QuoteRequest, shipped: ShippedOrder, active: ActiveTag, archived: ArchivedTag, expense: ValidExpense) {
  // @ts-expect-error quote requests cannot carry shipped orders
  const shippedQuote: QuoteRequest = { ...quote, order: shipped };
  // @ts-expect-error country and selected service cannot contradict each other
  const wrongService: QuoteRequest = { ...quote, service: 'domestic', request: { ...quote.request, country: 'US' } };
  // @ts-expect-error active state cannot masquerade as an archived proof
  const wrongArchive: ArchivedTag = active;
  // @ts-expect-error archived state cannot masquerade as an active proof
  const wrongActive: ActiveTag = archived;
  // @ts-expect-error lifecycle variants have no parallel boolean status
  const booleanStatus: LifecycleCommand = { ...active, archived: true };
  // @ts-expect-error an unconfirmed receipt is not enough for manager approval
  const missingReceipt: ExpenseDecision = { route: 'manager', expense };
  // @ts-expect-error receipt confirmation cannot contain receipt:false
  const contradictedReceipt: ReceiptedExpense = { ...expense, receipt: false };
  void [shippedQuote, wrongService, wrongArchive, wrongActive, booleanStatus, missingReceipt, contradictedReceipt];
}
void forbidden;
