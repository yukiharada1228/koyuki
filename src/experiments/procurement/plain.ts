import { receiveOrder, returnReceipt, correctReceipt } from './domain.js';
import { includeReceivedStock, includeChangedStock } from './inventory.js';
import type { StageSink, StageCapture } from './trace-contract.js';
import { procurementContext } from './context.js';
import type { StudyCommands } from './comparison-contract.js';
import type { ProcurementRepository, StorageError } from './repository.js';
import { ok, type Result } from '../../framework/index.js';
import type { Actor, Policy, Entity, Change, RuleError, CreateInput, EditInput, SubmitInput, VersionInput, ReasonInput, PlaceInput, AmendInput, ReceiveInput, CorrectInput, RegisterInput, PaymentInput } from './domain.js';
import type { StockInput, MoveInput, AdjustInput } from './inventory.js';
import { checkBuyerRequest, editCheckedRequest, withdrawCheckedRequest, checkApproverRequest, rejectCheckedRequest, returnCheckedRequest, reassignCheckedRequest, checkInvoice, approveCheckedInvoice, voidCheckedInvoice, checkOrder, amendCheckedOrder, cancelCheckedOrder, completeCheckedOrder, createRequest, submitCheckedRequest, approveCheckedRequest, placeCheckedOrder, registerInvoice, matchInvoice, recordPayment, cancelPayment } from './domain.js';
import { checkStock, reserveCheckedStock, releaseCheckedStock, moveCheckedStock, adjustCheckedStock } from './inventory.js';

/** plain TypeScript orchestration baseline: no business/Workflow execution. */
export const plainProcurement = (repository: ProcurementRepository, identity: Actor, policy: Policy, observe?: StageSink, capture?: StageCapture) => plainWithCommit(repository, identity, policy, observe, capture);
export function plainWithCommit<E>(repository: ProcurementRepository<E>, identity: Actor, policy: Policy, observe?: StageSink, capture?: StageCapture) {
  const context = procurementContext(repository, identity, policy);
  return {
    requests: {
      create: async (input: CreateInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.create(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const changed = createRequest(loaded.value); receiveRule?.(changed); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      edit: async (input: EditInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.request<EditInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkBuyerRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = editCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      submit: async (input: SubmitInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.approval(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkBuyerRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = submitCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      withdraw: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.request<VersionInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkBuyerRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = withdrawCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      approve: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.request<VersionInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkApproverRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = approveCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      reject: async (input: ReasonInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.request<ReasonInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkApproverRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = rejectCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      return: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.request<VersionInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkApproverRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = returnCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      reassign: async (input: SubmitInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.approval(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkApproverRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = reassignCheckedRequest(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    orders: {
      place: async (input: PlaceInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.place(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkBuyerRequest(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = placeCheckedOrder(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      amend: async (input: AmendInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.order<AmendInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkOrder(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = amendCheckedOrder(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      cancel: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.order<VersionInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkOrder(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = cancelCheckedOrder(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      complete: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.order<VersionInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkOrder(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = completeCheckedOrder(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    receipts: {
      receive: async (input: ReceiveInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.receive(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const decision = receiveOrder(loaded.value);
        const prepared = decision.ok ? ok(Object.freeze({ input: loaded.value, value: decision.value })) : decision;
        receiveRule?.(prepared); observe?.({ stage: 'rule', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
        const receiveStock = capture?.('rule:2', prepared.value);
        const changed = includeReceivedStock(prepared.value); receiveStock?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      return: async (input: ReasonInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.receipt<ReasonInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const decision = returnReceipt(loaded.value);
        const prepared = decision.ok ? ok(Object.freeze({ input: loaded.value, value: decision.value })) : decision;
        receiveRule?.(prepared); observe?.({ stage: 'rule', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
        const receiveStock = capture?.('rule:2', prepared.value);
        const changed = includeChangedStock(prepared.value); receiveStock?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      correct: async (input: CorrectInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.receipt<CorrectInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const decision = correctReceipt(loaded.value);
        const prepared = decision.ok ? ok(Object.freeze({ input: loaded.value, value: decision.value })) : decision;
        receiveRule?.(prepared); observe?.({ stage: 'rule', status: prepared.ok ? 'ok' : 'error' }); if (!prepared.ok) return prepared;
        const receiveStock = capture?.('rule:2', prepared.value);
        const changed = includeChangedStock(prepared.value); receiveStock?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    invoices: {
      register: async (input: RegisterInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.register(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const changed = registerInvoice(loaded.value); receiveRule?.(changed); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      match: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.match(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const changed = matchInvoice(loaded.value); receiveRule?.(changed); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      approve: async (input: VersionInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.invoice<VersionInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkInvoice(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = approveCheckedInvoice(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      void: async (input: ReasonInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.invoice<ReasonInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkInvoice(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = voidCheckedInvoice(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    payments: {
      record: async (input: PaymentInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.record(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const changed = recordPayment(loaded.value); receiveRule?.(changed); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      cancel: async (input: ReasonInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.payment(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveRule = capture?.('rule', loaded.value);
        const changed = cancelPayment(loaded.value); receiveRule?.(changed); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    inventory: {
      reserve: async (input: StockInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.inventory<StockInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkStock(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = reserveCheckedStock(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      release: async (input: StockInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.inventory<StockInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkStock(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = releaseCheckedStock(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      move: async (input: MoveInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.inventory<MoveInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkStock(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = moveCheckedStock(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      adjust: async (input: AdjustInput) => {
        const receiveLoad = capture?.('load', input);
        const loaded = await context.inventory<AdjustInput>(input); receiveLoad?.(loaded); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const receiveCheck = capture?.('rule', loaded.value);
        const checked = checkStock(loaded.value); receiveCheck?.(checked); observe?.({ stage: 'rule', status: checked.ok ? 'ok' : 'error' }); if (!checked.ok) return checked;
        const receiveRule = capture?.('rule:2', checked.value);
        const changed = adjustCheckedStock(checked.value); receiveRule?.(changed); observe?.({ stage: 'rule:2', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const receiveSave = capture?.('save', changed.value);
        const saved = await repository.commit(changed.value, context.actor);
        receiveSave?.(saved); observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
  } satisfies StudyCommands<E>;
}
