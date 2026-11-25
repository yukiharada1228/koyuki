import type { StageSink } from './trace-contract.js';
import { procurementContext } from './context.js';
import type { StudyCommands } from './comparison-contract.js';
import type { ProcurementRepository, StorageError } from './repository.js';
import type { Result } from '../../framework/index.js';
import type { Actor, Policy, Entity, Change, RuleError, CreateInput, EditInput, SubmitInput, VersionInput, ReasonInput, PlaceInput, AmendInput, ReceiveInput, CorrectInput, RegisterInput, PaymentInput } from './domain.js';
import type { StockInput, MoveInput, AdjustInput } from './inventory.js';
import { createRequest, editRequest, submitRequest, withdrawRequest, approveRequest, rejectRequest, returnRequest, reassignRequest, placeOrder, amendOrder, cancelOrder, completeOrder, registerInvoice, matchInvoice, approveInvoice, voidInvoice, recordPayment, cancelPayment } from './domain.js';
import { receiveIntoStock, returnFromStock, correctInStock, reserveStock, releaseStock, moveStock, adjustStock } from './inventory.js';

/** helper TypeScript orchestration baseline: no business/Workflow execution. */
export const helperProcurement = (repository: ProcurementRepository, identity: Actor, policy: Policy, observe?: StageSink) => helperWithCommit(repository, identity, policy, observe);
export function helperWithCommit<E>(repository: ProcurementRepository<E>, identity: Actor, policy: Policy, observe?: StageSink) {
  const context = procurementContext(repository, identity, policy);
  function action<I, C, T extends Entity, LE>(load: (input: I) => Promise<Result<C, LE>>, decide: (context: C) => Result<Change<T>, RuleError>) {
    return async (input: I) => {
      const loaded = await load(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const changed = decide(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
      const saved = await repository.commit(changed.value, context.actor);
      observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  return {
    requests: {
      create: action(context.create, createRequest),
      edit: action(context.request<EditInput>, editRequest),
      submit: action(context.approval, submitRequest),
      withdraw: action(context.request<VersionInput>, withdrawRequest),
      approve: action(context.request<VersionInput>, approveRequest),
      reject: action(context.request<ReasonInput>, rejectRequest),
      return: action(context.request<VersionInput>, returnRequest),
      reassign: action(context.approval, reassignRequest),
    },
    orders: {
      place: action(context.place, placeOrder),
      amend: action(context.order<AmendInput>, amendOrder),
      cancel: action(context.order<VersionInput>, cancelOrder),
      complete: action(context.order<VersionInput>, completeOrder),
    },
    receipts: {
      receive: action(context.receive, receiveIntoStock),
      return: action(context.receipt<ReasonInput>, returnFromStock),
      correct: action(context.receipt<CorrectInput>, correctInStock),
    },
    invoices: {
      register: action(context.register, registerInvoice),
      match: action(context.match, matchInvoice),
      approve: action(context.invoice<VersionInput>, approveInvoice),
      void: action(context.invoice<ReasonInput>, voidInvoice),
    },
    payments: {
      record: action(context.record, recordPayment),
      cancel: action(context.payment, cancelPayment),
    },
    inventory: {
      reserve: action(context.inventory<StockInput>, reserveStock),
      release: action(context.inventory<StockInput>, releaseStock),
      move: action(context.inventory<MoveInput>, moveStock),
      adjust: action(context.inventory<AdjustInput>, adjustStock),
    },
  } satisfies StudyCommands<E>;
}
