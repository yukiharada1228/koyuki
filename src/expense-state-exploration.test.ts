import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { exploreModel } from './framework/testing.js';
import { transition } from './framework/index.js';
import { submitted, approved, rejected, returned, edited } from './expenses/application.js';
import { restoreExpense, validExpenseChange, type ExpenseState, type Actor } from './expenses/domain.js';

// Independent reference specification: no domain validator, transition, routing
// function or persistence invariant is called to calculate the expected result.
interface Spec {
  kind: 'draft' | 'manager' | 'finance' | 'approved' | 'returned' | 'rejected';
  id: string; owner: string; amount: number; receipt: boolean; version: number;
  draftVersion?: number; manager?: string; by?: string; reason?: string;
  approval?: { kind: 'automatic' } | { kind: 'manager'; manager: string } | { kind: 'finance'; manager: string; finance: string };
}
type Event = { type: 'submit' | 'approve' | 'reject' | 'return' | 'edit'; actor: Actor; amount: number; receipt: boolean; reason: string };
type Expected = { next: Spec } | { error: string };
function reference(state: Spec, event: Event): Expected {
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
const actors: readonly Actor[] = [
  { id: 'owner', role: 'employee', active: true },
  { id: 'boss', role: 'manager', active: true },
  { id: 'accountant', role: 'finance', active: true },
  { id: 'boss', role: 'manager', active: false },
  { id: 'owner', role: 'employee', active: false },
  { id: 'accountant', role: 'finance', active: false },
  { id: 'other-boss', role: 'manager', active: true },
  { id: 'owner', role: 'manager', active: true },
];
const amounts = [3000, 3001, 100000, 100001] as const;
const events: Event[] = actors.flatMap(actor => [
  ...(['submit', 'approve'] as const).map(type => ({ type, actor, amount: 1, receipt: true, reason: '' })),
  ...(['reject', 'return'] as const).flatMap(type => [' ', ' correction '].map(reason => ({ type, actor, amount: 1, receipt: true, reason }))),
  ...[0, ...amounts].flatMap(amount => [false, true].map(receipt => ({ type: 'edit' as const, actor, amount, receipt, reason: '' }))),
]);
function actual(state: ExpenseState, event: Event) {
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

test('bounded breadth-first expense exploration agrees with an independent specification', t => {
  const depthLimit = 7;
  const initial: Spec[] = amounts.flatMap(amount => [false, true].map(receipt => ({ id: 'expense', owner: 'owner', amount, receipt, version: 1, kind: 'draft' as const })));
  const reached = new Set<string>();
  let failures = 0, repeatedCorrection = false, resubmission = false;
  const result = exploreModel({
    initial,
    key: state => JSON.stringify(state, (_key, value: unknown) => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value),
    events: () => events,
    step: (state, event) => {
      const output = reference(state, event);
      return { state: 'next' in output ? output.next : state, output };
    },
    check: (before, event, expected) => {
      reached.add(before.kind); reached.add(expected.state.kind);
      repeatedCorrection ||= (expected.state.draftVersion ?? 0) >= 7;
      resubmission ||= expected.state.kind === 'manager' && expected.state.draftVersion === 4;
      const restored = restoreExpense(before);
      if (!restored.ok) return false;
      const previous = structuredClone(restored.value), actualResult = actual(restored.value, event);
      if (!isDeepStrictEqual(previous, restored.value)) return false;
      if ('error' in expected.output) {
        failures++;
        return !actualResult.ok && actualResult.error.kind === expected.output.error && isDeepStrictEqual(expected.state, before);
      }
      if (!actualResult.ok || !isDeepStrictEqual(actualResult.value.next, expected.output.next)) return false;
      return validExpenseChange(restored.value, actualResult.value.next, before.version)
        && isDeepStrictEqual(restoreExpense(actualResult.value.next), { ok: true, value: actualResult.value.next });
    },
    limits: { depth: depthLimit, states: 1000, transitions: 100000 },
  });
  // Repeated correction cycles make the versioned model unbounded. Reaching the
  // selected horizon is a LIMITED result, never a universal proof of safety.
  assert(result.kind === 'limited' && isDeepStrictEqual(result.limits, ['depth']), JSON.stringify(result));
  assert.deepEqual([...reached].sort(), ['approved', 'draft', 'finance', 'manager', 'rejected', 'returned']);
  assert(result.states >= 100 && result.transitions > 10000 && failures > 10000);
  assert(repeatedCorrection && resubmission);
  t.diagnostic(JSON.stringify({ ...result, rejectedEdges: failures, eventsPerState: events.length }));
});
