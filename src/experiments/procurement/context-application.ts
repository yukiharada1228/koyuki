import { business } from '../../framework/index.js';
import { procurementProcessContext } from './context-process.js';
import { approveInvoice, voidInvoice, type Actor, type Change, type Invoice, type Receipt, type VersionInput, type ReasonInput, type CorrectInput } from './domain.js';
import { returnFromStock, correctInStock } from './inventory.js';
import type { ProcurementRepository } from './repository.js';

/** Integration experiment: the same domain rules and saves with composed read contexts. */
export function procurementComposedReads<E>(repository: ProcurementRepository<E>, identity: Actor) {
  const actor = Object.freeze({ ...identity });
  const context = procurementProcessContext(repository, actor);
  const invoices = business({ name: 'procurement.invoice.v1', load: context.invoice<VersionInput>,
    save: <T extends Invoice>(change: Change<T>) => repository.commit(change, actor),
    operations: {
      approve: [approveInvoice],
      void: { load: context.invoice<ReasonInput>, run: [voidInvoice] },
    } });
  const receipts = business({ name: 'procurement.receipt.v1', load: context.receipt<ReasonInput>,
    save: <T extends Receipt>(change: Change<T>) => repository.commit(change, actor),
    operations: {
      return: [returnFromStock],
      correct: { load: context.receipt<CorrectInput>, run: [correctInStock] },
    } });
  return { invoices, receipts };
}
