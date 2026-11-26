import { checkInvoiceRegistration, registerCheckedInvoice, checkInvoiceMatching, matchCheckedInvoice, checkPaymentRecording, recordCheckedPayment, checkPaymentCancellation, cancelCheckedPayment } from './domain.js';
import { receiveOrder, checkReceipt, returnCheckedReceipt, receiptCorrectionInput, finishReceiptCorrection } from './domain.js';
import { checkRequestCreation, parseRequestLines, requestCreationPlan } from './domain.js';
import { checkRequestEdit, requestEditPlan } from './domain.js';
import { includeReceivedStock, includeChangedStock, type ReceiptStockContext, type ReceiptDecision } from './inventory.js';
import type { StageSink, StageCapture } from './trace-contract.js';
import { procurementContext } from './context.js';
import type { StudyCommands } from './comparison-contract.js';
import type { ProcurementRepository, StorageError } from './repository.js';
import { ok, type Result } from '../../framework/index.js';
import type { Actor, Policy, Entity, Change, Receipt, RuleError, CreateInput, EditInput, SubmitInput, VersionInput, ReasonInput, PlaceInput, AmendInput, ReceiveInput, CorrectInput, RegisterInput, PaymentInput } from './domain.js';
import type { StockInput, MoveInput, AdjustInput } from './inventory.js';
import { checkBuyerRequest, withdrawCheckedRequest, checkApproverRequest, rejectCheckedRequest, returnCheckedRequest, reassignCheckedRequest, checkInvoice, approveCheckedInvoice, voidCheckedInvoice, checkOrder, amendCheckedOrder, cancelCheckedOrder, completeCheckedOrder, submitCheckedRequest, approveCheckedRequest, placeCheckedOrder } from './domain.js';
import { checkStock, reserveCheckedStock, releaseCheckedStock, moveCheckedStock, adjustCheckedStock } from './inventory.js';

/** helper TypeScript orchestration baseline: no business/Workflow execution. */
export const helperProcurement = (repository: ProcurementRepository, identity: Actor, policy: Policy, observe?: StageSink, capture?: StageCapture) => helperWithCommit(repository, identity, policy, observe, capture);
export function helperWithCommit<E>(repository: ProcurementRepository<E>, identity: Actor, policy: Policy, observe?: StageSink, capture?: StageCapture) {
  const context = procurementContext(repository, identity, policy);
  function checkedParsedAction<I, C, V, W, P, T extends Entity, LE, AE extends RuleError['kind'] = never, CE extends RuleError['kind'] = never, PE extends RuleError['kind'] = never>(load: (input: I) => Promise<Result<C, LE>>, authorize: (value: C) => Result<V, Readonly<{ kind: AE }>>, check: (value: V) => Result<W, Readonly<{ kind: CE }>>, parse: (value: W) => Result<P, Readonly<{ kind: PE }>>, finish: (value: W, parsed: P) => Change<T>) {
    return async (input: I) => {
      const receiveLoad = capture?.('load', input);
      const loaded = await load(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const receiveAuthorize = capture?.('rule', loaded.value);
      const authorized = authorize(loaded.value); receiveAuthorize?.(authorized); observe?.({ stage: 'rule', status: authorized.ok ? 'ok' : 'error' }); if (!authorized.ok) return authorized;
      const receiveCheck = capture?.('rule:2', authorized.value);
      const checked = check(authorized.value); receiveCheck?.(checked); observe?.({ stage: 'rule:2', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
      const receiveLines = capture?.('rule:3', checked.value);
      const parsed = parse(checked.value);
      const prepared = parsed.ok ? ok(Object.freeze({ input: checked.value, value: parsed.value })) : parsed;
      receiveLines?.(prepared); observe?.({ stage: 'rule:3', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
      const receivePlan = capture?.('rule:4', prepared.value);
      const change = finish(prepared.value.input, prepared.value.value), changed = ok(change);
      receivePlan?.(changed); observe?.({ stage: 'rule:4', status: 'ok' });
      const receiveSave = capture?.('save', change);
      const saved = await repository.commit(change, context.actor); receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  function parsedAction<I, C, V, P, T extends Entity, LE, CE extends RuleError['kind'] = never, PE extends RuleError['kind'] = never>(load: (input: I) => Promise<Result<C, LE>>, check: (value: C) => Result<V, Readonly<{ kind: CE }>>, parse: (value: V) => Result<P, Readonly<{ kind: PE }>>, finish: (value: V, parsed: P) => Change<T>) {
    return async (input: I) => {
      const receiveLoad = capture?.('load', input);
      const loaded = await load(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const receiveCheck = capture?.('rule', loaded.value);
      const checked = check(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
      const receiveLines = capture?.('rule:2', checked.value);
      const parsed = parse(checked.value);
      const prepared = parsed.ok ? ok(Object.freeze({ input: checked.value, value: parsed.value })) : parsed;
      receiveLines?.(prepared); observe?.({ stage: 'rule:2', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
      const receivePlan = capture?.('rule:3', prepared.value);
      const change = finish(prepared.value.input, prepared.value.value), changed = ok(change); receivePlan?.(changed); observe?.({ stage: 'rule:3', status: 'ok' });
      const receiveSave = capture?.('save', change);
      const saved = await repository.commit(change, context.actor); receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  function checkedAction<I, C, V, T extends Entity, LE, CE extends RuleError['kind'] = never, DE extends RuleError['kind'] = never>(load: (input: I) => Promise<Result<C, LE>>, check: (value: C) => Result<V, Readonly<{ kind: CE }>>, decide: (value: V) => Result<Change<T>, Readonly<{ kind: DE }>>) {
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
  function receiptAction<I, C, T extends Receipt, LE, DE extends RuleError['kind'] = never, IE extends RuleError['kind'] = never>(load: (input: I) => Promise<Result<C, LE>>, decide: (value: C) => Result<Change<T>, Readonly<{ kind: DE }>>, include: (pair: ReceiptDecision<C, T>) => Result<Change<T>, Readonly<{ kind: IE }>>) {
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
  function checkedReceiptAction<I, C, V, T extends Receipt, LE, CE extends RuleError['kind'] = never, DE extends RuleError['kind'] = never, IE extends RuleError['kind'] = never>(load: (input: I) => Promise<Result<C, LE>>, check: (value: C) => Result<V, Readonly<{ kind: CE }>>, decide: (value: V) => Result<Change<T>, Readonly<{ kind: DE }>>, include: (pair: ReceiptDecision<V, T>) => Result<Change<T>, Readonly<{ kind: IE }>>) {
    return async (input: I) => {
      const receiveLoad = capture?.('load', input);
      const loaded = await load(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
      const receiveCheck = capture?.('rule', loaded.value);
      const checked = check(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
      const receiveRule = capture?.('rule:2', checked.value);
      const decision = decide(checked.value);
      const prepared = decision.ok ? ok(Object.freeze({ input: checked.value, value: decision.value })) : decision;
      receiveRule?.(prepared); observe?.({ stage: 'rule:2', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
      const receiveStock = capture?.('rule:3', prepared.value);
      const changed = include(prepared.value); receiveStock?.(changed); observe?.({ stage: 'rule:3', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
      const receiveSave = capture?.('save', changed.value);
      const saved = await repository.commit(changed.value, context.actor); receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  function correctionAction() {
    return async (input: CorrectInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.receipt<CorrectInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkReceipt(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveQuantity = capture?.('rule:2', checked.value);
        const quantities = receiveOrder(receiptCorrectionInput(checked.value));
        const validated = quantities.ok ? ok(Object.freeze({ input: checked.value, value: quantities.value })) : quantities;
        receiveQuantity?.(validated); observe?.({ stage: 'rule:2', status: validated.ok ? 'ok' : 'error' }); if (!validated.ok) return validated;
        const receivePlan = capture?.('rule:3', validated.value);
        const prepared = Object.freeze({ input: validated.value.input, value: finishReceiptCorrection(validated.value.input, validated.value.value) });
        receivePlan?.(ok(prepared)); observe?.({ stage: 'rule:3', status: 'ok' });
        const receiveStock = capture?.('rule:4', prepared);
        const changed = includeChangedStock(prepared); receiveStock?.(changed); observe?.({ stage: 'rule:4', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
    };
  }
  return {
    requests: {
      create: parsedAction(context.create, checkRequestCreation, value => parseRequestLines(value.input.lines), requestCreationPlan),
      edit: checkedParsedAction(context.request<EditInput>, checkBuyerRequest, checkRequestEdit, value => parseRequestLines(value.input.lines), requestEditPlan),
      submit: checkedAction(context.approval, checkBuyerRequest, submitCheckedRequest),
      withdraw: checkedAction(context.request<VersionInput>, checkBuyerRequest, withdrawCheckedRequest),
      approve: checkedAction(context.request<VersionInput>, checkApproverRequest, approveCheckedRequest),
      reject: checkedAction(context.request<ReasonInput>, checkApproverRequest, rejectCheckedRequest),
      return: checkedAction(context.request<VersionInput>, checkApproverRequest, returnCheckedRequest),
      reassign: checkedAction(context.approval, checkApproverRequest, reassignCheckedRequest),
    },
    orders: {
      place: checkedAction(context.place, checkBuyerRequest, placeCheckedOrder),
      amend: checkedAction(context.order<AmendInput>, checkOrder, amendCheckedOrder),
      cancel: checkedAction(context.order<VersionInput>, checkOrder, cancelCheckedOrder),
      complete: checkedAction(context.order<VersionInput>, checkOrder, completeCheckedOrder),
    },
    receipts: {
      receive: receiptAction(context.receive, receiveOrder, includeReceivedStock),
      return: checkedReceiptAction(context.receipt<ReasonInput>, checkReceipt<ReceiptStockContext<ReasonInput>>, returnCheckedReceipt, includeChangedStock),
      correct: correctionAction(),
    },
    invoices: {
      register: checkedAction(context.register, checkInvoiceRegistration, registerCheckedInvoice),
      match: checkedAction(context.match, checkInvoiceMatching, matchCheckedInvoice),
      approve: checkedAction(context.invoice<VersionInput>, checkInvoice, approveCheckedInvoice),
      void: checkedAction(context.invoice<ReasonInput>, checkInvoice, voidCheckedInvoice),
    },
    payments: {
      record: checkedAction(context.record, checkPaymentRecording, recordCheckedPayment),
      cancel: checkedAction(context.payment, checkPaymentCancellation, cancelCheckedPayment),
    },
    inventory: {
      reserve: checkedAction(context.inventory<StockInput>, checkStock, reserveCheckedStock),
      release: checkedAction(context.inventory<StockInput>, checkStock, releaseCheckedStock),
      move: checkedAction(context.inventory<MoveInput>, checkStock, moveCheckedStock),
      adjust: checkedAction(context.inventory<AdjustInput>, checkStock, adjustCheckedStock),
    },
  } satisfies StudyCommands<E>;
}
