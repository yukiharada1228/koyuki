import { receiveOrder, returnReceipt, correctReceipt } from './domain.js';
import { includeReceivedStock, includeChangedStock, type ReceiptDecision } from './inventory.js';
import type { StageSink, StageCapture } from './trace-contract.js';
import { procurementContext } from './context.js';
import type { StudyCommands } from './comparison-contract.js';
import type { ProcurementRepository, StorageError } from './repository.js';
import { ok, type Result } from '../../framework/index.js';
import type { Actor, Policy, Entity, Change, Receipt, RuleError, CreateInput, EditInput, SubmitInput, VersionInput, ReasonInput, PlaceInput, AmendInput, ReceiveInput, CorrectInput, RegisterInput, PaymentInput } from './domain.js';
import type { StockInput, MoveInput, AdjustInput } from './inventory.js';
import { checkBuyerRequest, editCheckedRequest, withdrawCheckedRequest, checkApproverRequest, rejectCheckedRequest, returnCheckedRequest, reassignCheckedRequest, checkInvoice, approveCheckedInvoice, voidCheckedInvoice, checkOrder, amendCheckedOrder, cancelCheckedOrder, completeCheckedOrder, createRequest, submitRequest, approveRequest, placeOrder, registerInvoice, matchInvoice, recordPayment, cancelPayment } from './domain.js';
import { reserveStock, releaseStock, moveStock, adjustStock } from './inventory.js';

/** helper TypeScript orchestration baseline: no business/Workflow execution. */
export const helperProcurement = (repository: ProcurementRepository, identity: Actor, policy: Policy, observe?: StageSink, capture?: StageCapture) => helperWithCommit(repository, identity, policy, observe, capture);
export function helperWithCommit<E>(repository: ProcurementRepository<E>, identity: Actor, policy: Policy, observe?: StageSink, capture?: StageCapture) {
  const context = procurementContext(repository, identity, policy);
  function action<I, C, T extends Entity, LE>(load: (input: I) => Promise<Result<C, LE>>, decide: (context: C) => Result<Change<T>, RuleError>) {
    return async (input: I) => {
      const receiveLoad = capture?.('load', input);
        const loaded = await load(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const receiveRule = capture?.('rule', loaded.value);
        const changed = decide(loaded.value); receiveRule?.(changed); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
      const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
      receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  function checkedAction<I, C, V, T extends Entity, LE>(load: (input: I) => Promise<Result<C, LE>>, check: (value: C) => Result<V, RuleError>, decide: (value: V) => Result<Change<T>, RuleError>) {
    return async (input: I) => {
      const receiveLoad = capture?.('load', input);
      const loaded = await load(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const receiveCheck = capture?.('rule', loaded.value);
      const checked = check(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
      const receiveRule = capture?.('rule:2', checked.value);
      const changed = decide(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
      const receiveSave = capture?.('save', changed.value);
      const saved = await repository.commit(changed.value, context.actor); receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  function receiptAction<I, C, T extends Entity, LE>(load: (input: I) => Promise<Result<C, LE>>, decide: (value: C) => Result<Change<Receipt>, RuleError>, include: (pair: ReceiptDecision<C>) => Result<Change<T>, RuleError>) {
    return async (input: I) => {
      const receiveLoad = capture?.('load', input);
      const loaded = await load(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const receiveRule = capture?.('rule', loaded.value);
      const decision = decide(loaded.value);
      const prepared = decision.ok ? ok(Object.freeze({ input: loaded.value, value: decision.value })) : decision;
      receiveRule?.(prepared); observe?.({ stage: 'rule', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
      const receiveStock = capture?.('rule:2', prepared.value);
      const changed = include(prepared.value); receiveStock?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
      const receiveSave = capture?.('save', changed.value);
      const saved = await repository.commit(changed.value, context.actor); receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  return {
    requests: {
      create: action(context.create, createRequest),
      edit: checkedAction(context.request<EditInput>, checkBuyerRequest, editCheckedRequest),
      submit: action(context.approval, submitRequest),
      withdraw: checkedAction(context.request<VersionInput>, checkBuyerRequest, withdrawCheckedRequest),
      approve: action(context.request<VersionInput>, approveRequest),
      reject: checkedAction(context.request<ReasonInput>, checkApproverRequest, rejectCheckedRequest),
      return: checkedAction(context.request<VersionInput>, checkApproverRequest, returnCheckedRequest),
      reassign: checkedAction(context.approval, checkApproverRequest, reassignCheckedRequest),
    },
    orders: {
      place: action(context.place, placeOrder),
      amend: checkedAction(context.order<AmendInput>, checkOrder, amendCheckedOrder),
      cancel: checkedAction(context.order<VersionInput>, checkOrder, cancelCheckedOrder),
      complete: checkedAction(context.order<VersionInput>, checkOrder, completeCheckedOrder),
    },
    receipts: {
      receive: receiptAction(context.receive, receiveOrder, includeReceivedStock),
      return: receiptAction(context.receipt<ReasonInput>, returnReceipt, includeChangedStock),
      correct: receiptAction(context.receipt<CorrectInput>, correctReceipt, includeChangedStock),
    },
    invoices: {
      register: action(context.register, registerInvoice),
      match: action(context.match, matchInvoice),
      approve: checkedAction(context.invoice<VersionInput>, checkInvoice, approveCheckedInvoice),
      void: checkedAction(context.invoice<ReasonInput>, checkInvoice, voidCheckedInvoice),
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
