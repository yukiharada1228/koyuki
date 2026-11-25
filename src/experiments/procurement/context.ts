import { ok } from '../../framework/index.js';
import { stockId, type StockInput } from './inventory.js';
import type { Actor, Policy, CreateInput, VersionInput, SubmitInput, PlaceInput, ReceiveInput, RegisterInput, PaymentInput, ReasonInput } from './domain.js';
import type { ProcurementRepository } from './repository.js';
/** Shared host data preparation for all three orchestration implementations. */
export function procurementContext<E>(repository: ProcurementRepository<E>, identity: Actor, configuration: Policy) {
  const actor = Object.freeze({ ...identity });
  const policy = Object.freeze({ requestLimitCents: configuration.requestLimitCents, approverIds: Object.freeze([...configuration.approverIds]) });
  const loadStock = async () => {
    const row = await repository.read('stock', stockId, actor);
    return row.ok ? ok(row.value) : row.error.kind === 'NotFound' ? ok(null) : row;
  };
  const loadInventory = async <I extends StockInput>(input: I) => {
    const stock = await loadStock(); return stock.ok ? ok({ input, actor, stock: stock.value }) : stock;
  };
  const loadRequest = async <I extends VersionInput>(input: I) => {
    const row = await repository.read('request', input.id, actor); return row.ok ? ok({ input, actor, current: row.value }) : row;
  };
  const loadOrder = async <I extends VersionInput>(input: I) => {
    const row = await repository.read('order', input.id, actor); return row.ok ? ok({ input, actor, current: row.value }) : row;
  };
  const loadOrderFacts = async <I extends VersionInput>(input: I) => {
    const loaded = await loadOrder(input); if (!loaded.ok) return loaded;
    return ok({ ...loaded.value,
      receipts: await repository.related('receipt', input.id, actor),
      invoices: (await repository.related('invoice', input.id, actor)).filter(row => row.state !== 'voided') });
  };
  const loadInvoice = async <I extends VersionInput>(input: I) => {
    const current = await repository.read('invoice', input.id, actor); if (!current.ok) return current;
    const order = await repository.read('order', current.value.orderId, actor); if (!order.ok) return order;
    return ok({ input, actor, current: current.value, order: order.value });
  };
  const loadReceipt = async <I extends VersionInput>(input: I) => {
    const current = await repository.read('receipt', input.id, actor); if (!current.ok) return current;
    const order = await repository.read('order', current.value.orderId, actor); if (!order.ok) return order;
    const stock = await loadStock(); if (!stock.ok) return stock;
    return ok({ stock: stock.value, input, actor, current: current.value, order: order.value,
      receipts: await repository.related('receipt', order.value.id, actor),
      invoices: (await repository.related('invoice', order.value.id, actor)).filter(row => row.state !== 'voided') });
  };
  return {
    actor,
    create: async (input: CreateInput) => ok({ input, actor }),
    request: loadRequest, order: loadOrderFacts, receipt: loadReceipt, invoice: loadInvoice, inventory: loadInventory,
    approval: async (input: SubmitInput) => { const loaded = await loadRequest(input); return loaded.ok ? ok({ ...loaded.value, policy }) : loaded; },
    place: async (input: PlaceInput) => { const loaded = await loadRequest(input); return loaded.ok ? ok({ ...loaded.value, alreadyOrdered: (await repository.related('order', input.id, actor)).some(order => order.state !== 'cancelled') }) : loaded; },
    receive: async (input: ReceiveInput) => {
      const loaded = await loadOrder(input); if (!loaded.ok) return loaded;
      const stock = await loadStock(); if (!stock.ok) return stock;
      return ok({ ...loaded.value, stock: stock.value, receipts: await repository.related('receipt', input.id, actor) });
    },
    register: async (input: RegisterInput) => { const loaded = await loadOrder(input); return loaded.ok ? ok({ ...loaded.value, alreadyInvoiced: (await repository.related('invoice', input.id, actor)).some(invoice => invoice.state !== 'voided') }) : loaded; },
    match: async (input: VersionInput) => { const loaded = await loadInvoice(input); return loaded.ok ? ok({ ...loaded.value, receipts: await repository.related('receipt', loaded.value.order.id, actor) }) : loaded; },
    record: async (input: PaymentInput) => {
      const current = await repository.read('invoice', input.id, actor); if (!current.ok) return current;
      return ok({ input, actor, current: current.value, alreadyRecorded: (await repository.related('payment', input.id, actor)).some(payment => payment.state === 'recorded') });
    },
    payment: async (input: ReasonInput) => { const current = await repository.read('payment', input.id, actor); return current.ok ? ok({ input, actor, current: current.value }) : current; },
  };
}
