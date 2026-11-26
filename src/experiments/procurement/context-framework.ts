import { ok, process, workflow } from '../../framework/index.js';
import { stockId, type StockInput } from './inventory.js';
import type { Actor, Policy, CreateInput, VersionInput, SubmitInput, PlaceInput, ReceiveInput, RegisterInput, PaymentInput, ReasonInput } from './domain.js';
import type { ProcurementRepository } from './repository.js';
import { procurementProcessContext } from './context-process.js';

/** Koyuki host preparation. Conventional baselines keep context.ts and do not run these Processes. */
export function procurementFrameworkContext<E>(repository: ProcurementRepository<E>, identity: Actor, configuration: Policy) {
  const policy = Object.freeze({ receiptDepletion: configuration.receiptDepletion, requestLimitCents: configuration.requestLimitCents, approverIds: Object.freeze([...configuration.approverIds]),
    ...(configuration.secondApproval === undefined ? {} : { secondApproval: Object.freeze({ ...configuration.secondApproval }) }) });
  const reads = procurementProcessContext(repository, identity, policy), { actor } = reads;
  const initial = <I>(input: I) => ({ input, actor });
  type Input<I> = { input: I; actor: Actor };
  const stock = async () => {
    const result = await repository.read('stock', stockId, actor);
    // A missing stock row means an empty stock model; other failures must stop.
    return result.ok ? ok(result.value) : result.error.kind === 'NotFound' ? ok(null) : result;
  };
  const request = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-request', async context => repository.read('request', context.input.id, actor), 'current');
  const order = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-order', async context => repository.read('order', context.input.id, actor), 'current');
  const invoice = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-invoice', async context => repository.read('invoice', context.input.id, actor), 'current');
  return {
    actor,
    create: async (input: CreateInput) => ok(initial(input)),
    request: <I extends VersionInput>(input: I) => request<I>().run(initial(input)),
    order: <I extends VersionInput>(input: I) => order<I>()
      .effect('read-related', async context => ok({ receipts: await repository.related('receipt', context.input.id, actor),
        invoices: (await repository.related('invoice', context.input.id, actor)).filter(row => row.state !== 'voided') }),
      (context, related) => ({ ...context, ...related })).run(initial(input)),
    receipt: reads.receipt,
    invoice: reads.invoice,
    inventory: <I extends StockInput>(input: I) => process<Input<I>>()
      .effect('read-stock', stock, 'stock').run(initial(input)),
    approval: (input: SubmitInput) => request<SubmitInput>()
      .through(workflow('approval-policy', context => ok({ ...context, policy }))).run(initial(input)),
    place: (input: PlaceInput) => request<PlaceInput>()
      .effect('read-related-orders', async context => ok((await repository.related('order', context.input.id, actor)).some(row => row.state !== 'cancelled')),
        'alreadyOrdered').run(initial(input)),
    receive: (input: ReceiveInput) => order<ReceiveInput>()
      .effect('read-stock', stock, 'stock')
      .effect('read-related-receipts', async context => ok(await repository.related('receipt', context.input.id, actor)),
        'receipts').run(initial(input)),
    register: (input: RegisterInput) => order<RegisterInput>()
      .effect('read-related-invoices', async context => ok((await repository.related('invoice', context.input.id, actor)).some(row => row.state !== 'voided')),
        'alreadyInvoiced').run(initial(input)),
    match: (input: VersionInput) => process<VersionInput>().effect('load-invoice', reads.invoice<VersionInput>)
      .effect('read-related-receipts', async context => ok(await repository.related('receipt', context.order.id, actor)),
        'receipts').run(input),
    record: (input: PaymentInput) => invoice<PaymentInput>()
      .effect('read-related-payments', async context => ok((await repository.related('payment', context.input.id, actor)).some(row => row.state === 'recorded')),
        'alreadyRecorded').run(initial(input)),
    payment: (input: ReasonInput) => process<Input<ReasonInput>>()
      .effect('read-payment', async context => repository.read('payment', context.input.id, actor),
        'current').run(initial(input)),
  };
}
