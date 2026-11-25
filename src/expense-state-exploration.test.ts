import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { exploreModel, type ModelStep } from './framework/testing.js';
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

const initial: Spec[] = amounts.flatMap(amount => [false, true].map(receipt => ({ id: 'expense', owner: 'owner', amount, receipt, version: 1, kind: 'draft' as const })));
const modelKey = (state: Spec) => JSON.stringify(state, (_key, value: unknown) => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
function modelStep(state: Spec, event: Event): ModelStep<Spec, Expected> {
  const output = reference(state, event);
  return { state: 'next' in output ? output.next : state, output };
}
function matchesImplementation(before: Spec, event: Event, expected: ModelStep<Spec, Expected>): boolean {
  const restored = restoreExpense(before);
  if (!restored.ok) return false;
  const previous = structuredClone(restored.value), actualResult = actual(restored.value, event);
  if (!isDeepStrictEqual(previous, restored.value)) return false;
  if ('error' in expected.output) return !actualResult.ok && actualResult.error.kind === expected.output.error && isDeepStrictEqual(expected.state, before);
  if (!actualResult.ok || !isDeepStrictEqual(actualResult.value.next, expected.output.next)) return false;
  return validExpenseChange(restored.value, actualResult.value.next, before.version)
    && isDeepStrictEqual(restoreExpense(actualResult.value.next), { ok: true, value: actualResult.value.next });
}
function noSelfApproval(state: Spec): boolean {
  if (state.manager === state.owner) return false;
  const approval = state.approval;
  if (!approval || approval.kind === 'automatic') return true;
  return approval.manager !== state.owner && (approval.kind !== 'finance' || approval.finance !== state.owner);
}

test('bounded breadth-first expense exploration agrees with an independent specification', t => {
  const depthLimit = 7;
  const reached = new Set<string>();
  let failures = 0, repeatedCorrection = false, resubmission = false;
  const result = exploreModel({
    initial,
    key: modelKey,
    events: () => events,
    step: modelStep,
    check: (before, event, expected) => {
      reached.add(before.kind); reached.add(expected.state.kind);
      repeatedCorrection ||= (expected.state.draftVersion ?? 0) >= 7;
      resubmission ||= expected.state.kind === 'manager' && expected.state.draftVersion === 4;
      if ('error' in expected.output) failures++;
      return matchesImplementation(before, event, expected);
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

test('the finite approval episode exhausts its graph without self approval or terminal reapproval', t => {
  // This scenario deliberately excludes edit/resubmission, which would make
  // version growth unbounded. Return is terminal only WITHIN this event set.
  const episodeEvents = events.filter(event => event.type !== 'edit');
  let terminalChecks = 0, selfChecks = 0;
  const result = exploreModel({
    initial, key: modelKey, events: () => episodeEvents, step: modelStep,
    invariant: noSelfApproval,
    check: (before, event, expected) => {
      if (event.type === 'approve' && ['approved', 'rejected', 'returned'].includes(before.kind)) {
        terminalChecks++;
        if (!('error' in expected.output) || expected.output.error !== 'InvalidState' || !isDeepStrictEqual(before, expected.state)) return false;
      }
      if (event.type === 'approve' && (before.kind === 'manager' || before.kind === 'finance') && event.actor.id === before.owner) {
        selfChecks++;
        if (!('error' in expected.output) || expected.output.error !== 'SelfApproval' || !isDeepStrictEqual(before, expected.state)) return false;
      }
      return matchesImplementation(before, event, expected);
    },
    limits: { depth: 4, states: 1000, transitions: 100000 },
  });
  assert.equal(result.kind, 'passed', JSON.stringify(result));
  assert(terminalChecks > 0 && selfChecks > 0);
  t.diagnostic(JSON.stringify({ ...result, terminalChecks, selfChecks, eventsPerState: episodeEvents.length }));
});

test('the no-self-approval invariant exposes a deliberately broken reference transition', () => {
  const result = exploreModel({
    initial: initial.filter(state => state.amount === 100001 && state.receipt),
    key: modelKey, events: () => events.filter(event => event.type === 'submit' || event.type === 'approve'),
    step: (state, event): ModelStep<Spec, Expected> => {
      if (state.kind === 'manager' && event.type === 'approve' && event.actor.id === state.owner) {
        const next: Spec = { ...state, kind: 'approved', version: state.version + 1, approval: { kind: 'manager', manager: state.owner } };
        return { state: next, output: { next } };
      }
      return modelStep(state, event);
    },
    invariant: noSelfApproval,
    // Model-only mutation probe: the independent invariant must catch the
    // corrupt model even with no implementation comparison to rescue it.
    check: () => true,
    limits: { depth: 4, states: 1000, transitions: 100000 },
  });
  assert(result.kind === 'counterexample' && result.reason === 'invariant', JSON.stringify(result));
  assert.deepEqual(result.witness.events.map(event => event.type), ['submit', 'approve']);
  assert.equal(result.witness.events[1]!.actor.id, result.witness.initial.owner);
});
