import { business } from '../../framework/index.js';
import { procurementProcessContext } from './context-process.js';
import { approveInvoice, voidInvoice, type Actor, type ReceiptDepletion, type Change, type Invoice, type Receipt, type VersionInput, type ReasonInput, type CorrectInput } from './domain.js';
import { returnFromStock, correctInStock } from './inventory.js';
import type { ProcurementRepository } from './repository.js';

/** Integration experiment: the same domain rules and saves with composed read contexts. */
export function procurementComposedReads<E>(repository: ProcurementRepository<E>, identity: Actor, options: { detailedLoad?: boolean; receiptDepletion?: ReceiptDepletion } = {}) {
  const actor = Object.freeze({ ...identity });
  const context = procurementProcessContext(repository, actor, options);
  const invoiceLoad = <I extends VersionInput>() => options.detailedLoad ? context.invoiceDetailed<I>() : context.invoice<I>;
  const receiptLoad = <I extends VersionInput>() => options.detailedLoad ? context.receiptDetailed<I>() : context.receipt<I>;
  const invoices = business({ name: 'procurement.invoice.v1', load: invoiceLoad<VersionInput>(),
    save: <T extends Invoice>(change: Change<T>) => repository.commit(change, actor),
    operations: {
      approve: [approveInvoice],
      void: { load: invoiceLoad<ReasonInput>(), run: [voidInvoice] },
    } });
  const receipts = business({ name: 'procurement.receipt.v1', load: receiptLoad<ReasonInput>(),
    save: <T extends Receipt>(change: Change<T>) => repository.commit(change, actor),
    operations: {
      return: [returnFromStock],
      correct: { load: receiptLoad<CorrectInput>(), run: [correctInStock] },
    } });
  return { invoices, receipts };
}
