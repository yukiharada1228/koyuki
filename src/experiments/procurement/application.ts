import { receiveDecision, returnDecision, correctDecision } from './receipt-pipeline.js';
import { procurementFrameworkContext as procurementContext } from './context-framework.js';
import { includeReceivedStock, includeChangedStock, checkStock, reserveCheckedStock, releaseCheckedStock, moveCheckedStock, adjustCheckedStock, type StockInput, type MoveInput, type AdjustInput } from './inventory.js';
import { business, ok, type Result } from '../../framework/index.js';
import { checkReceipt, checkBuyerRequest, editCheckedRequest, withdrawCheckedRequest, checkApproverRequest, rejectCheckedRequest, returnCheckedRequest, reassignCheckedRequest, checkInvoice, approveCheckedInvoice, voidCheckedInvoice, checkOrder, amendCheckedOrder, cancelCheckedOrder, completeCheckedOrder, recordPayment, cancelPayment, createRequest, submitCheckedRequest, approveCheckedRequest, placeCheckedOrder, registerInvoice, matchInvoice,
  type Entity, type Stock, type CorrectInput, type Payment, type PaymentInput, type Actor, type Policy, type Request, type Order, type Invoice, type Receipt, type Change, type AmendInput, type EditInput, type ReasonInput, type CreateInput, type VersionInput, type SubmitInput, type PlaceInput, type ReceiveInput, type RegisterInput } from './domain.js';
import type { ProcurementRepository } from './repository.js';
export type Committed<T extends Entity = Entity> = Readonly<{ result: T; writes: readonly Entity[] }>;
type Saved<T extends Entity, Detailed extends boolean> = Detailed extends true ? Committed<T> : T;
export const procurement = <E>(repository: ProcurementRepository<E>, identity: Actor, configuration: Policy) => createProcurement(repository, identity, configuration, false);
export const procurementChanges = <E>(repository: ProcurementRepository<E>, identity: Actor, configuration: Policy) => createProcurement(repository, identity, configuration, true);
function createProcurement<const Detailed extends boolean, E>(repository: ProcurementRepository<E>, identity: Actor, configuration: Policy, detailed: Detailed) {
  const context = procurementContext(repository, identity, configuration), { actor } = context;
  const save = async <T extends Entity>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => {
    // Capture before the adapter receives mutable references; failed commits publish no delta.
    const writes = detailed ? structuredClone(change.writes) : [];
    const result = await repository.commit(change, actor); if (!result.ok) return result;
    // Detailed is selected only by the two fixed public factories above.
    return ok((detailed ? { result: result.value, writes } : result.value) as Saved<T, Detailed>);
  };
  const requests = business({ name: 'procurement.request.v1', load: context.create,
    save: <T extends Request>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => save(change), operations: {
      create: [createRequest],
      edit: { load: context.request<EditInput>, run: [checkBuyerRequest, editCheckedRequest] },
      withdraw: { load: context.request<VersionInput>, run: [checkBuyerRequest, withdrawCheckedRequest] },
      reject: { load: context.request<ReasonInput>, run: [checkApproverRequest, rejectCheckedRequest] },
      return: { load: context.request<VersionInput>, run: [checkApproverRequest, returnCheckedRequest] },
      reassign: { load: context.approval, run: [checkApproverRequest, reassignCheckedRequest] },
      submit: { load: context.approval, run: [checkBuyerRequest, submitCheckedRequest] },
      approve: { load: context.request<VersionInput>, run: [checkApproverRequest, approveCheckedRequest] },
    } });
  const orders = business({ name: 'procurement.order.v1', load: context.place,
    save: <T extends Order>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => save(change), operations: {
      place: [checkBuyerRequest, placeCheckedOrder],
      amend: { load: context.order<AmendInput>, run: [checkOrder, amendCheckedOrder] },
      cancel: { load: context.order<VersionInput>, run: [checkOrder, cancelCheckedOrder] },
      complete: { load: context.order<VersionInput>, run: [checkOrder, completeCheckedOrder] },
    } });
  const receipts = business({ name: 'procurement.receipt.v1', load: context.receive,
    save: <T extends Receipt>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => save(change), operations: {
      receive: [receiveDecision, includeReceivedStock],
      return: { load: context.receipt<ReasonInput>, run: [checkReceipt, returnDecision, includeChangedStock] },
      correct: { load: context.receipt<CorrectInput>, run: [checkReceipt, correctDecision, includeChangedStock] },
    } });
  const invoices = business({ name: 'procurement.invoice.v1', load: context.register,
    save: <T extends Invoice>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => save(change), operations: {
      register: [registerInvoice],
      approve: { load: context.invoice<VersionInput>, run: [checkInvoice, approveCheckedInvoice] },
      void: { load: context.invoice<ReasonInput>, run: [checkInvoice, voidCheckedInvoice] },
      match: { load: context.match, run: [matchInvoice] },
    } });
  const payments = business({ name: 'procurement.payment.v1', load: context.record,
    save: <T extends Payment>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => save(change), operations: {
      record: [recordPayment], cancel: { load: context.payment, run: [cancelPayment] },
    } });
  const inventory = business({ name: 'procurement.inventory.v1', load: context.inventory<StockInput>,
    save: <T extends Stock>(change: Change<T>): Promise<Result<Saved<T, Detailed>, E>> => save(change), operations: {
      reserve: [checkStock, reserveCheckedStock], release: [checkStock, releaseCheckedStock],
      move: { load: context.inventory<MoveInput>, run: [checkStock, moveCheckedStock] },
      adjust: { load: context.inventory<AdjustInput>, run: [checkStock, adjustCheckedStock] },
    } });
  return { requests, orders, receipts, invoices, payments, inventory };
}
