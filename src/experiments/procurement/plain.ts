import { procurementContext } from './context.js';
import type { StudyCommands } from './comparison-contract.js';
import type { ProcurementRepository, StorageError } from './repository.js';
import type { Result } from '../../framework/index.js';
import type { Actor, Policy, Entity, Change, RuleError, CreateInput, EditInput, SubmitInput, VersionInput, ReasonInput, PlaceInput, AmendInput, ReceiveInput, CorrectInput, RegisterInput, PaymentInput } from './domain.js';
import type { StockInput, MoveInput, AdjustInput } from './inventory.js';
import { createRequest, editRequest, submitRequest, withdrawRequest, approveRequest, rejectRequest, returnRequest, reassignRequest, placeOrder, amendOrder, cancelOrder, completeOrder, registerInvoice, matchInvoice, approveInvoice, voidInvoice, recordPayment, cancelPayment } from './domain.js';
import { receiveIntoStock, returnFromStock, correctInStock, reserveStock, releaseStock, moveStock, adjustStock } from './inventory.js';

/** plain TypeScript orchestration baseline: no business/Workflow execution. */
export function plainProcurement(repository: ProcurementRepository, identity: Actor, policy: Policy) {
  const context = procurementContext(repository, identity, policy);
  return {
    requests: {
      create: async (input: CreateInput) => {
        const loaded = await context.create(input); if (!loaded.ok) return loaded;
        const changed = createRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      edit: async (input: EditInput) => {
        const loaded = await context.request<EditInput>(input); if (!loaded.ok) return loaded;
        const changed = editRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      submit: async (input: SubmitInput) => {
        const loaded = await context.approval(input); if (!loaded.ok) return loaded;
        const changed = submitRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      withdraw: async (input: VersionInput) => {
        const loaded = await context.request<VersionInput>(input); if (!loaded.ok) return loaded;
        const changed = withdrawRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      approve: async (input: VersionInput) => {
        const loaded = await context.request<VersionInput>(input); if (!loaded.ok) return loaded;
        const changed = approveRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      reject: async (input: ReasonInput) => {
        const loaded = await context.request<ReasonInput>(input); if (!loaded.ok) return loaded;
        const changed = rejectRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      return: async (input: VersionInput) => {
        const loaded = await context.request<VersionInput>(input); if (!loaded.ok) return loaded;
        const changed = returnRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      reassign: async (input: SubmitInput) => {
        const loaded = await context.approval(input); if (!loaded.ok) return loaded;
        const changed = reassignRequest(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
    },
    orders: {
      place: async (input: PlaceInput) => {
        const loaded = await context.place(input); if (!loaded.ok) return loaded;
        const changed = placeOrder(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      amend: async (input: AmendInput) => {
        const loaded = await context.order<AmendInput>(input); if (!loaded.ok) return loaded;
        const changed = amendOrder(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      cancel: async (input: VersionInput) => {
        const loaded = await context.order<VersionInput>(input); if (!loaded.ok) return loaded;
        const changed = cancelOrder(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      complete: async (input: VersionInput) => {
        const loaded = await context.order<VersionInput>(input); if (!loaded.ok) return loaded;
        const changed = completeOrder(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
    },
    receipts: {
      receive: async (input: ReceiveInput) => {
        const loaded = await context.receive(input); if (!loaded.ok) return loaded;
        const changed = receiveIntoStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      return: async (input: ReasonInput) => {
        const loaded = await context.receipt<ReasonInput>(input); if (!loaded.ok) return loaded;
        const changed = returnFromStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      correct: async (input: CorrectInput) => {
        const loaded = await context.receipt<CorrectInput>(input); if (!loaded.ok) return loaded;
        const changed = correctInStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
    },
    invoices: {
      register: async (input: RegisterInput) => {
        const loaded = await context.register(input); if (!loaded.ok) return loaded;
        const changed = registerInvoice(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      match: async (input: VersionInput) => {
        const loaded = await context.match(input); if (!loaded.ok) return loaded;
        const changed = matchInvoice(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      approve: async (input: VersionInput) => {
        const loaded = await context.invoice<VersionInput>(input); if (!loaded.ok) return loaded;
        const changed = approveInvoice(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      void: async (input: ReasonInput) => {
        const loaded = await context.invoice<ReasonInput>(input); if (!loaded.ok) return loaded;
        const changed = voidInvoice(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
    },
    payments: {
      record: async (input: PaymentInput) => {
        const loaded = await context.record(input); if (!loaded.ok) return loaded;
        const changed = recordPayment(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      cancel: async (input: ReasonInput) => {
        const loaded = await context.payment(input); if (!loaded.ok) return loaded;
        const changed = cancelPayment(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
    },
    inventory: {
      reserve: async (input: StockInput) => {
        const loaded = await context.inventory<StockInput>(input); if (!loaded.ok) return loaded;
        const changed = reserveStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      release: async (input: StockInput) => {
        const loaded = await context.inventory<StockInput>(input); if (!loaded.ok) return loaded;
        const changed = releaseStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      move: async (input: MoveInput) => {
        const loaded = await context.inventory<MoveInput>(input); if (!loaded.ok) return loaded;
        const changed = moveStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
      adjust: async (input: AdjustInput) => {
        const loaded = await context.inventory<AdjustInput>(input); if (!loaded.ok) return loaded;
        const changed = adjustStock(loaded.value); if (!changed.ok) return changed;
        return repository.commit(changed.value, context.actor);
      },
    },
  } satisfies StudyCommands;
}
