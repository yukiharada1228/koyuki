import { ok, process } from '../../framework/index.js';
import type { Actor, VersionInput, Policy } from './domain.js';
import { stockId } from './inventory.js';
import type { ProcurementRepository } from './repository.js';

type Input<I> = { input: I; actor: Actor };

/** Alternative loaders kept separate from the common baseline and all public APIs. */
export function procurementProcessContext<E>(repository: ProcurementRepository<E>, identity: Actor, configuration: Pick<Policy, 'receiptDepletion'> = {}) {
  const actor = Object.freeze({ ...identity });
  const receiptDepletion = configuration.receiptDepletion;
  const initial = <I extends VersionInput>(input: I) => ({ input, actor });
  const invoiceFlow = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-invoice', async context => repository.read('invoice', context.input.id, actor), (context, current) => ({ ...context, current }))
    .effect('read-order', async context => repository.read('order', context.current.orderId, actor), (context, order) => ({ ...context, order }));
  const receiptFlow = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-receipt', async context => repository.read('receipt', context.input.id, actor), (context, current) => ({ ...context, current }))
    .effect('read-order', async context => repository.read('order', context.current.orderId, actor), (context, order) => ({ ...context, order }))
    .effect('read-stock', async () => {
      const row = await repository.read('stock', stockId, actor);
      // Missing stock is a domain interpretation, not an automatic error recovery policy.
      return row.ok ? ok(row.value) : row.error.kind === 'NotFound' ? ok(null) : row;
    }, (context, stock) => ({ ...context, stock }))
    .effect('read-related', async context => ok({ ...context, receiptDepletion,
      receipts: await repository.related('receipt', context.order.id, actor),
      invoices: (await repository.related('invoice', context.order.id, actor)).filter(row => row.state !== 'voided'),
    }));
  const invoice = <I extends VersionInput>(input: I) => invoiceFlow<I>().run(initial(input));
  const receipt = <I extends VersionInput>(input: I) => receiptFlow<I>().run(initial(input));
  const invoiceDetailed = <I extends VersionInput>() => ({ runDetailed: (input: I) => invoiceFlow<I>().runDetailed(initial(input)) });
  const receiptDetailed = <I extends VersionInput>() => ({ runDetailed: (input: I) => receiptFlow<I>().runDetailed(initial(input)) });
  return { invoice, receipt, invoiceDetailed, receiptDetailed };
}
