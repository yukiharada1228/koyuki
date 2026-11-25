import { isDeepStrictEqual } from 'node:util';
import type { ModelStep, AsyncSequenceModel } from '../framework/testing.js';
import { transition } from '../framework/index.js';
import { submitted, approved, rejected, returned, edited } from './application.js';
import { restoreExpense, validExpenseChange, type ExpenseState, type Actor } from './domain.js';

// Independent reference specification: no domain validator, transition, routing
// function or persistence invariant is called to calculate the expected result.
export interface Spec {
  kind: 'draft' | 'manager' | 'finance' | 'approved' | 'returned' | 'rejected';
  id: string; owner: string; amount: number; receipt: boolean; version: number;
  draftVersion?: number; manager?: string; by?: string; reason?: string;
  approval?: { kind: 'automatic' } | { kind: 'manager'; manager: string } | { kind: 'finance'; manager: string; finance: string };
}
export type Event = { type: 'submit' | 'approve' | 'reject' | 'return' | 'edit'; actor: Actor; amount: number; receipt: boolean; reason: string };
export type Expected = { next: Spec } | { error: string };
export function reference(state: Spec, event: Event): Expected {
  const actor = event.actor;
  const data = { id: state.id, owner: state.owner, amount: state.amount, receipt: state.receipt, version: state.version + 1,
    ...(state.draftVersion === undefined ? {} : { draftVersion: state.draftVersion }) };
  if (event.type === 'submit') {
    if (state.kind !== 'draft') return { error: 'InvalidState' };
    if (!actor.active || actor.id !== state.owner) return { error: 'Forbidden' };
    if (state.amount <= 3000) return { next: { ...data, kind: 'approved', approval: { kind: 'automatic' } } };
    if (!state.receipt) return { error: 'ReceiptRequired' };
    return { next: { ...data, kind: 'manager' } };
  }
  if (event.type === 'edit') {
    if (state.kind !== 'returned') return { error: 'InvalidState' };
    if (!actor.active || actor.id !== state.owner) return { error: 'Forbidden' };
    if (!Number.isSafeInteger(event.amount) || event.amount <= 0) return { error: 'InvalidExpense' };
    return { next: { ...data, kind: 'draft', amount: event.amount, receipt: event.receipt, draftVersion: data.version } };
  }
  if (state.kind !== 'manager' && state.kind !== 'finance') return { error: 'InvalidState' };
  if (actor.id === state.owner) return { error: 'SelfApproval' };
  if (!actor.active || actor.role !== state.kind) return { error: 'Forbidden' };
  if (event.type !== 'approve') {
    if (!event.reason.trim()) return { error: 'ReasonRequired' };
    return { next: { ...data, kind: event.type === 'reject' ? 'rejected' : 'returned', by: actor.id, reason: event.reason.trim(),
      ...(state.kind === 'finance' ? { manager: state.manager! } : {}) } };
  }
  if (state.kind === 'manager') return state.amount > 100000
    ? { next: { ...data, kind: 'finance', manager: actor.id } }
    : { next: { ...data, kind: 'approved', approval: { kind: 'manager', manager: actor.id } } };
  return { next: { ...data, kind: 'approved', approval: { kind: 'finance', manager: state.manager!, finance: actor.id } } };
}
const flows = { submit: transition(submitted), approve: transition(approved), reject: transition(rejected), return: transition(returned), edit: transition(edited) };
export const actors: readonly Actor[] = [
  { id: 'owner', role: 'employee', active: true },
  { id: 'boss', role: 'manager', active: true },
  { id: 'accountant', role: 'finance', active: true },
  { id: 'boss', role: 'manager', active: false },
  { id: 'owner', role: 'employee', active: false },
  { id: 'accountant', role: 'finance', active: false },
  { id: 'other-boss', role: 'manager', active: true },
  { id: 'owner', role: 'manager', active: true },
];
export const amounts = [3000, 3001, 100000, 100001] as const;
export const events: Event[] = actors.flatMap(actor => [
  ...(['submit', 'approve'] as const).map(type => ({ type, actor, amount: 1, receipt: true, reason: '' })),
  ...(['reject', 'return'] as const).flatMap(type => [' ', ' correction '].map(reason => ({ type, actor, amount: 1, receipt: true, reason }))),
  ...[0, ...amounts].flatMap(amount => [false, true].map(receipt => ({ type: 'edit' as const, actor, amount, receipt, reason: '' }))),
]);
export function actual(state: ExpenseState, event: Event) {
  const input = { id: state.id, expectedVersion: state.version, amount: event.amount, receipt: event.receipt, reason: event.reason };
  const command = { current: state, actor: event.actor, input };
  switch (event.type) {
    case 'submit': return flows.submit.run(command);
    case 'approve': return flows.approve.run(command);
    case 'reject': return flows.reject.run(command);
    case 'return': return flows.return.run(command);
    case 'edit': return flows.edit.run(command);
  }
}

export const initial: Spec[] = amounts.flatMap(amount => [false, true].map(receipt => ({ id: 'expense', owner: 'owner', amount, receipt, version: 1, kind: 'draft' as const })));
export const modelKey = (state: Spec) => JSON.stringify(state, (_key, value: unknown) => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
export function modelStep(state: Spec, event: Event): ModelStep<Spec, Expected> {
  const output = reference(state, event);
  return { state: 'next' in output ? output.next : state, output };
}
export function matchesImplementation(before: Spec, event: Event, expected: ModelStep<Spec, Expected>, execute: typeof actual = actual): boolean {
  const restored = restoreExpense(before);
  if (!restored.ok) return false;
  const previous = structuredClone(restored.value), actualResult = execute(restored.value, event);
  if (!isDeepStrictEqual(previous, restored.value)) return false;
  if ('error' in expected.output) return !actualResult.ok && actualResult.error.kind === expected.output.error && isDeepStrictEqual(expected.state, before);
  if (!actualResult.ok || !isDeepStrictEqual(actualResult.value.next, expected.output.next)) return false;
  return validExpenseChange(restored.value, actualResult.value.next, before.version)
    && isDeepStrictEqual(restoreExpense(actualResult.value.next), { ok: true, value: actualResult.value.next });
}
export function noSelfApproval(state: Spec): boolean {
  if (state.manager === state.owner) return false;
  const approval = state.approval;
  if (!approval || approval.kind === 'automatic') return true;
  return approval.manager !== state.owner && (approval.kind !== 'finance' || approval.finance !== state.owner);
}

export function sequenceEvents(state: Spec): readonly Event[] {
  return state.kind === 'draft' ? events.filter(event => event.type === 'submit')
    : state.kind === 'returned' ? events.filter(event => event.type === 'edit')
    : state.kind === 'manager' || state.kind === 'finance' ? events.filter(event => event.type !== 'edit')
    : events.filter(event => event.actor === actors[0] && (event.type === 'submit' || event.type === 'approve'));
}

// Pure domain execution only. Persistence and host authorization are separate contracts.
export const models = {
  'expense-domain': {
    initial,
    limits: { cases: 64, length: 32, shrinkAttempts: 200 },
    events: sequenceEvents,
    step: modelStep,
    invariant: noSelfApproval,
    check: matchesImplementation,
  },
} satisfies Record<string, Omit<AsyncSequenceModel<Spec, Event, Expected>, 'seed'>>;
