import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { AsyncSequenceModel, ModelStep } from '../framework/testing.js';
import { draftExpense } from './domain.js';
import { initial as drafts, reference, sequenceEvents, type Spec, type Event as DomainEvent } from './model-testing.js';
import { ReplaySqliteExpenses, type ExpenseRequest } from './sqlite-replay.js';
import { expenseReplayCommands } from './replay.js';

type Alter = 'same' | 'input' | 'actor' | 'actor-id' | 'actor-role' | 'target' | 'operation' | 'reason' | 'amount' | 'receipt';
export type RequestEvent = { type: 'call'; key: number; event: DomainEvent; stale: boolean }
  | { type: 'repeat'; receipt: number; alter: Alter };
type Outcome = { kind: 'committed' | 'replayed'; value: Spec } | { kind: 'error'; error: string };
interface StoredReceipt { request: ExpenseRequest; value: Spec }
export interface RequestState {
  readonly start: Spec; readonly expense: Spec;
  readonly receipts: readonly StoredReceipt[]; readonly history: readonly RequestEvent[];
}
export const initial: readonly RequestState[] = drafts.map(start => ({ start, expense: start, receipts: [], history: [] }));

function applicable(request: ExpenseRequest, alter: Alter): boolean {
  return alter === 'reason' ? ['reject', 'return'].includes(request.operation)
    : alter === 'amount' || alter === 'receipt' ? request.operation === 'edit' : true;
}

export function requestFor(state: RequestState, event: RequestEvent): ExpenseRequest {
  if (event.type === 'repeat') {
    const receipt = state.receipts[event.receipt]; if (!receipt) throw new Error('RequestReferenceOutsideModel');
    const request = receipt.request;
    if (!applicable(request, event.alter)) throw new Error('RequestAlterationOutsideModel');
    switch (event.alter) {
      case 'same': return request;
      case 'input': return { ...request, input: { ...request.input, expectedVersion: request.input.expectedVersion + 1 } };
      case 'actor': return { ...request, actor: { ...request.actor, active: !request.actor.active } };
      case 'actor-id': return { ...request, actor: { ...request.actor, id: request.actor.id + '-other' } };
      case 'actor-role': return { ...request, actor: { ...request.actor, role: request.actor.role === 'employee' ? 'manager' : 'employee' } };
      case 'target': return { ...request, input: { ...request.input, id: request.input.id + '-other' } };
      case 'operation': return { ...request, operation: request.operation === 'submit' ? 'approve' : 'submit' };
      case 'reason': if ('reason' in request.input) return { ...request, input: { ...request.input, reason: request.input.reason + '!' } }; break;
      case 'amount': if ('amount' in request.input) return { ...request, input: { ...request.input, amount: request.input.amount + 1 } }; break;
      case 'receipt': if ('receipt' in request.input) return { ...request, input: { ...request.input, receipt: !request.input.receipt } }; break;
    }
    throw new Error('MissingReferenceInputField');
  }
  const operation = event.event.type;
  return { requestId: `request-${event.key}`, operation, actor: event.event.actor,
    input: { id: state.expense.id, expectedVersion: state.expense.version - (event.stale ? 1 : 0),
      ...(['reject', 'return'].includes(operation) ? { reason: event.event.reason } : {}),
      ...(operation === 'edit' ? { amount: event.event.amount, receipt: event.event.receipt } : {}) },
  };
}

// Independent specification: compare canonical request fields directly, not the
// implementation's fingerprint, receipt query or command result.
export function requestStep(before: RequestState, event: RequestEvent): ModelStep<RequestState, Outcome> {
  const request = requestFor(before, event), history = [...before.history, event];
  const unchanged = (output: Outcome) => ({ state: { ...before, history }, output });
  if (request.input.expectedVersion <= 0) return unchanged({ kind: 'error', error: 'InvalidRequest' });
  const receipt = before.receipts.find(item => item.request.requestId === request.requestId);
  if (receipt) return unchanged(isDeepStrictEqual(receipt.request, request)
    ? { kind: 'replayed', value: receipt.value } : { kind: 'error', error: 'IdempotencyConflict' });
  if (request.input.expectedVersion !== before.expense.version) return unchanged({ kind: 'error', error: 'SaveConflict' });
  if (event.type !== 'call') throw new Error('MissingReferenceReceipt');
  const expected = reference(before.expense, event.event);
  if ('error' in expected) return unchanged({ kind: 'error', error: expected.error });
  return { state: { ...before, expense: expected.next, history,
    receipts: [...before.receipts, { request, value: expected.next }] }, output: { kind: 'committed', value: expected.next } };
}

export function requestEvents(state: RequestState, random: () => number): readonly RequestEvent[] {
  const domain = sequenceEvents(state.expense);
  const calls: RequestEvent[] = domain.map(event => ({ type: 'call', key: state.history.length, event, stale: false }));
  const selected = domain[Math.floor(random() * domain.length)]!;
  calls.push({ type: 'call', key: state.history.length, event: selected, stale: true });
  for (const receipt of new Set([0, state.receipts.length - 1])) if (state.receipts[receipt]) {
    for (const alter of ['same', 'input', 'actor', 'actor-id', 'actor-role', 'target', 'operation', 'reason', 'amount', 'receipt'] as const) {
      if (applicable(state.receipts[receipt]!.request, alter)) calls.push({ type: 'repeat', receipt, alter });
    }
  }
  return calls;
}

async function execute(repository: ReplaySqliteExpenses, request: ExpenseRequest): Promise<Outcome> {
  const commands = expenseReplayCommands(repository, request.actor), base = { id: request.input.id, expectedVersion: request.input.expectedVersion };
  const call = { requestId: request.requestId, input: { ...base,
    reason: 'reason' in request.input ? request.input.reason : '',
    amount: 'amount' in request.input ? request.input.amount : 1,
    receipt: 'receipt' in request.input ? request.input.receipt : false } };
  // Pass only the operation's declared fields; irrelevant extras are outside this model.
  const result = request.operation === 'edit' ? await commands.edit.run({ requestId: call.requestId, input: { ...base, amount: call.input.amount, receipt: call.input.receipt } })
    : request.operation === 'reject' ? await commands.reject.run({ requestId: call.requestId, input: { ...base, reason: call.input.reason } })
    : request.operation === 'return' ? await commands.return.run({ requestId: call.requestId, input: { ...base, reason: call.input.reason } })
    : await commands[request.operation].run({ requestId: call.requestId, input: base });
  return result.ok ? { kind: result.value.kind, value: result.value.value } : { kind: 'error', error: result.error.kind };
}

export async function compareRequest(before: RequestState, event: RequestEvent, expected: ModelStep<RequestState, Outcome>, forgetReplayKind = false): Promise<boolean> {
  const repository = new ReplaySqliteExpenses(':memory:');
  try {
    const start = before.start, draft = draftExpense({ id: start.id, owner: start.owner, amount: start.amount, receipt: start.receipt });
    assert(draft.ok); assert(repository.insertDraft(draft.value).ok);
    let state: RequestState = { start, expense: start, receipts: [], history: [] };
    const stored = (expense: Spec) => isDeepStrictEqual(repository.list(), { ok: true, value: [expense] });
    const perform = async (request: ExpenseRequest): Promise<Outcome> => {
      const result = await execute(repository, request);
      return forgetReplayKind && result.kind === 'replayed' ? { ...result, kind: 'committed' } : result;
    };
    for (const previous of before.history) {
      const wanted = requestStep(state, previous), actual = await perform(requestFor(state, previous));
      if (!isDeepStrictEqual(actual, wanted.output) || !stored(wanted.state.expense)) return false;
      state = wanted.state;
    }
    if (!isDeepStrictEqual(state, before) || !stored(before.expense)) return false;
    return isDeepStrictEqual(await perform(requestFor(before, event)), expected.output) && stored(expected.state.expense);
  } finally { repository.close(); }
}

export const models = { 'expense-request-sqlite': {
  initial, limits: { cases: 4, length: 32, shrinkAttempts: 200 }, events: requestEvents, step: requestStep,
  accepts: (state: RequestState, event: RequestEvent) => event.type === 'call' || !!state.receipts[event.receipt] && applicable(state.receipts[event.receipt]!.request, event.alter),
  check: compareRequest,
} } satisfies Record<string, Omit<AsyncSequenceModel<RequestState, RequestEvent, Outcome>, 'seed'>>;
