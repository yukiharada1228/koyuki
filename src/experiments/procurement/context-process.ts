import { ok, process, type Result } from '../../framework/index.js';
import type { Actor, VersionInput } from './domain.js';
import { stockId } from './inventory.js';
import type { ProcurementRepository } from './repository.js';

/** Experiment only: retain earlier facts while Process owns failure propagation.
 * These contexts are ordinary DTO records. This is not an arbitrary object merge API.
 */
function attach<C, const K extends string, V, E>(key: K, read: (context: C) => Result<V, E> | Promise<Result<V, E>>) {
  return async (context: C): Promise<Result<C & Record<K, V>, E>> => {
    const value = await read(context);
    return value.ok ? ok(Object.assign({}, context, { [key]: value.value }) as C & Record<K, V>) : value;
  };
}
type Input<I> = { input: I; actor: Actor };

/** Alternative loaders kept separate from the common baseline and all public APIs. */
export function procurementProcessContext<E>(repository: ProcurementRepository<E>, identity: Actor) {
  const actor = Object.freeze({ ...identity });
  const initial = <I extends VersionInput>(input: I) => ({ input, actor });
  const invoiceFlow = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-invoice', attach('current', context => repository.read('invoice', context.input.id, actor)))
    .effect('read-order', attach('order', context => repository.read('order', context.current.orderId, actor)));
  const receiptFlow = <I extends VersionInput>() => process<Input<I>>()
    .effect('read-receipt', attach('current', context => repository.read('receipt', context.input.id, actor)))
    .effect('read-order', attach('order', context => repository.read('order', context.current.orderId, actor)))
    .effect('read-stock', attach('stock', async () => {
      const row = await repository.read('stock', stockId, actor);
      // Missing stock is a domain interpretation, not an automatic error recovery policy.
      return row.ok ? ok(row.value) : row.error.kind === 'NotFound' ? ok(null) : row;
    }))
    .effect('read-related', async context => ok({ ...context,
      receipts: await repository.related('receipt', context.order.id, actor),
      invoices: (await repository.related('invoice', context.order.id, actor)).filter(row => row.state !== 'voided'),
    }));
  const invoice = <I extends VersionInput>(input: I) => invoiceFlow<I>().run(initial(input));
  const receipt = <I extends VersionInput>(input: I) => receiptFlow<I>().run(initial(input));
  const invoiceDetailed = <I extends VersionInput>() => ({ runDetailed: (input: I) => invoiceFlow<I>().runDetailed(initial(input)) });
  const receiptDetailed = <I extends VersionInput>() => ({ runDetailed: (input: I) => receiptFlow<I>().runDetailed(initial(input)) });
  return { invoice, receipt, invoiceDetailed, receiptDetailed };
}
