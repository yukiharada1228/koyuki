import type { StageSink } from './trace-contract.js';
import { procurementContext } from './context.js';
import type { StudyCommands } from './comparison-contract.js';
import type { ProcurementRepository, StorageError } from './repository.js';
import type { Result } from '../../framework/index.js';
import type { Actor, Policy, Entity, Change, RuleError, CreateInput, EditInput, SubmitInput, VersionInput, ReasonInput, PlaceInput, AmendInput, ReceiveInput, CorrectInput, RegisterInput, PaymentInput } from './domain.js';
import type { StockInput, MoveInput, AdjustInput } from './inventory.js';
import { createRequest, editRequest, submitRequest, withdrawRequest, approveRequest, rejectRequest, returnRequest, reassignRequest, placeOrder, amendOrder, cancelOrder, completeOrder, registerInvoice, matchInvoice, approveInvoice, voidInvoice, recordPayment, cancelPayment } from './domain.js';
import { receiveIntoStock, returnFromStock, correctInStock, reserveStock, releaseStock, moveStock, adjustStock } from './inventory.js';

/** plain TypeScript orchestration baseline: no business/Workflow execution. */
export const plainProcurement = (repository: ProcurementRepository, identity: Actor, policy: Policy, observe?: StageSink) => plainWithCommit(repository, identity, policy, observe);
export function plainWithCommit<E>(repository: ProcurementRepository<E>, identity: Actor, policy: Policy, observe?: StageSink) {
  const context = procurementContext(repository, identity, policy);
  return {
    requests: {
      create: async (input: CreateInput) => {
        const loaded = await context.create(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = createRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      edit: async (input: EditInput) => {
        const loaded = await context.request<EditInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = editRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      submit: async (input: SubmitInput) => {
        const loaded = await context.approval(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = submitRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      withdraw: async (input: VersionInput) => {
        const loaded = await context.request<VersionInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = withdrawRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      approve: async (input: VersionInput) => {
        const loaded = await context.request<VersionInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = approveRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      reject: async (input: ReasonInput) => {
        const loaded = await context.request<ReasonInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = rejectRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      return: async (input: VersionInput) => {
        const loaded = await context.request<VersionInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = returnRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      reassign: async (input: SubmitInput) => {
        const loaded = await context.approval(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = reassignRequest(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    orders: {
      place: async (input: PlaceInput) => {
        const loaded = await context.place(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = placeOrder(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      amend: async (input: AmendInput) => {
        const loaded = await context.order<AmendInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = amendOrder(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      cancel: async (input: VersionInput) => {
        const loaded = await context.order<VersionInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = cancelOrder(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      complete: async (input: VersionInput) => {
        const loaded = await context.order<VersionInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = completeOrder(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    receipts: {
      receive: async (input: ReceiveInput) => {
        const loaded = await context.receive(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = receiveIntoStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      return: async (input: ReasonInput) => {
        const loaded = await context.receipt<ReasonInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = returnFromStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      correct: async (input: CorrectInput) => {
        const loaded = await context.receipt<CorrectInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = correctInStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    invoices: {
      register: async (input: RegisterInput) => {
        const loaded = await context.register(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = registerInvoice(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      match: async (input: VersionInput) => {
        const loaded = await context.match(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = matchInvoice(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      approve: async (input: VersionInput) => {
        const loaded = await context.invoice<VersionInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = approveInvoice(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      void: async (input: ReasonInput) => {
        const loaded = await context.invoice<ReasonInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = voidInvoice(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    payments: {
      record: async (input: PaymentInput) => {
        const loaded = await context.record(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = recordPayment(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      cancel: async (input: ReasonInput) => {
        const loaded = await context.payment(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = cancelPayment(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
    inventory: {
      reserve: async (input: StockInput) => {
        const loaded = await context.inventory<StockInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = reserveStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      release: async (input: StockInput) => {
        const loaded = await context.inventory<StockInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = releaseStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      move: async (input: MoveInput) => {
        const loaded = await context.inventory<MoveInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = moveStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
      adjust: async (input: AdjustInput) => {
        const loaded = await context.inventory<AdjustInput>(input); observe?.({ stage: 'load', status: loaded.ok ? 'ok' : 'error' }); if (!loaded.ok) return loaded;
        const changed = adjustStock(loaded.value); observe?.({ stage: 'rule', status: changed.ok ? 'ok' : 'error' }); if (!changed.ok) return changed;
        const saved = await repository.commit(changed.value, context.actor);
        observe?.({ stage: 'save', status: saved.ok ? 'ok' : 'error' }); return saved;
      },
    },
  } satisfies StudyCommands<E>;
}
