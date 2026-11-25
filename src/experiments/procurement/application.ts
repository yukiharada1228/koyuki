import { business, ok } from '../../framework/index.js';
import { recordPayment, cancelPayment, approveInvoice, voidInvoice, amendOrder, cancelOrder, completeOrder, editRequest, withdrawRequest, rejectRequest, returnRequest, reassignRequest, createRequest, submitRequest, approveRequest, placeOrder, receiveOrder, registerInvoice, matchInvoice,
  type Payment, type PaymentInput, type Actor, type Policy, type Request, type Order, type Invoice, type Receipt, type Change, type AmendInput, type EditInput, type ReasonInput, type CreateInput, type VersionInput, type SubmitInput, type PlaceInput, type ReceiveInput, type RegisterInput } from './domain.js';
import type { ProcurementRepository } from './repository.js';
export function procurement(repository: ProcurementRepository, identity: Actor, configuration: Policy) {
  const actor = Object.freeze({ ...identity });
  const policy = Object.freeze({ requestLimitCents: configuration.requestLimitCents, approverIds: Object.freeze([...configuration.approverIds]) });
  const loadRequest = async <I extends VersionInput>(input: I) => {
    const row = await repository.read('request', input.id, actor); return row.ok ? ok({ input, actor, current: row.value }) : row;
  };
  const loadOrder = async <I extends VersionInput>(input: I) => {
    const row = await repository.read('order', input.id, actor); return row.ok ? ok({ input, actor, current: row.value }) : row;
  };
  const loadOrderFacts = async <I extends VersionInput>(input: I) => {
    const loaded = await loadOrder(input); if (!loaded.ok) return loaded;
    return ok({ ...loaded.value,
      receipts: (await repository.list('receipt', actor)).filter(row => row.orderId === input.id),
      invoices: (await repository.list('invoice', actor)).filter(row => row.orderId === input.id && row.state !== 'voided') });
  };
  const loadInvoice = async <I extends VersionInput>(input: I) => {
    const current = await repository.read('invoice', input.id, actor); if (!current.ok) return current;
    const order = await repository.read('order', current.value.orderId, actor); if (!order.ok) return order;
    return ok({ input, actor, current: current.value, order: order.value });
  };
  const requests = business({ name: 'procurement.request.v1', load: async (input: CreateInput) => ok({ input, actor }),
    save: (change: Change<Request>) => repository.commit(change, actor), operations: {
      create: [createRequest],
      edit: { load: (input: EditInput) => loadRequest(input), run: [editRequest] },
      withdraw: { load: (input: VersionInput) => loadRequest(input), run: [withdrawRequest] },
      reject: { load: (input: ReasonInput) => loadRequest(input), run: [rejectRequest] },
      return: { load: (input: VersionInput) => loadRequest(input), run: [returnRequest] },
      reassign: { load: async (input: SubmitInput) => { const loaded = await loadRequest(input); return loaded.ok ? ok({ ...loaded.value, policy }) : loaded; }, run: [reassignRequest] },
      submit: { load: async (input: SubmitInput) => { const loaded = await loadRequest(input); return loaded.ok ? ok({ ...loaded.value, policy }) : loaded; }, run: [submitRequest] },
      approve: { load: (input: VersionInput) => loadRequest(input), run: [approveRequest] },
    } });
  const orders = business({ name: 'procurement.order.v1', load: async (input: PlaceInput) => {
    const loaded = await loadRequest(input);
    return loaded.ok ? ok({ ...loaded.value, alreadyOrdered: (await repository.list('order', actor)).some(order => order.requestId === input.id && order.state !== 'cancelled') }) : loaded;
  }, save: (change: Change<Order>) => repository.commit(change, actor), operations: {
    place: [placeOrder],
    amend: { load: (input: AmendInput) => loadOrderFacts(input), run: [amendOrder] },
    cancel: { load: (input: VersionInput) => loadOrderFacts(input), run: [cancelOrder] },
    complete: { load: (input: VersionInput) => loadOrderFacts(input), run: [completeOrder] },
  } });
  const receipts = business({ name: 'procurement.receipt.v1', load: async (input: ReceiveInput) => {
    const loaded = await loadOrder(input);
    return loaded.ok ? ok({ ...loaded.value, receipts: (await repository.list('receipt', actor)).filter(receipt => receipt.orderId === input.id) }) : loaded;
  }, save: (change: Change<Receipt>) => repository.commit(change, actor), operations: { receive: [receiveOrder] } });
  const invoices = business({ name: 'procurement.invoice.v1', load: async (input: RegisterInput) => {
    const loaded = await loadOrder(input);
    return loaded.ok ? ok({ ...loaded.value, alreadyInvoiced: (await repository.list('invoice', actor)).some(invoice => invoice.orderId === input.id && invoice.state !== 'voided') }) : loaded;
  }, save: (change: Change<Invoice>) => repository.commit(change, actor), operations: {
    register: [registerInvoice],
    approve: { load: (input: VersionInput) => loadInvoice(input), run: [approveInvoice] },
    void: { load: (input: ReasonInput) => loadInvoice(input), run: [voidInvoice] },
    match: { load: async (input: VersionInput) => {
      const current = await repository.read('invoice', input.id, actor); if (!current.ok) return current;
      const order = await repository.read('order', current.value.orderId, actor); if (!order.ok) return order;
      return ok({ input, actor, current: current.value, order: order.value, receipts: (await repository.list('receipt', actor)).filter(receipt => receipt.orderId === order.value.id) });
    }, run: [matchInvoice] },
  } });
  const payments = business({ name: 'procurement.payment.v1', load: async (input: PaymentInput) => {
    const current = await repository.read('invoice', input.id, actor); if (!current.ok) return current;
    return ok({ input, actor, current: current.value, alreadyRecorded: (await repository.list('payment', actor)).some(payment => payment.invoiceId === input.id && payment.state === 'recorded') });
  }, save: (change: Change<Payment>) => repository.commit(change, actor), operations: {
    record: [recordPayment],
    cancel: { load: async (input: ReasonInput) => {
      const current = await repository.read('payment', input.id, actor); return current.ok ? ok({ input, actor, current: current.value }) : current;
    }, run: [cancelPayment] },
  } });
  return { requests, orders, receipts, invoices, payments };
}
