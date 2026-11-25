import test from 'node:test';
import assert from 'node:assert/strict';
import { transition } from './framework/index.js';
import { submitted, approved, rejected, returned, edited } from './expenses/application.js';
import { draftExpense, restoreExpense, validExpenseChange, type ExpenseState, type Actor } from './expenses/domain.js';

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
  const queue: { actual: ExpenseState; spec: Spec; initial: Spec; path: Event[] }[] = [];
  const seen = new Set<string>();
  const enqueue = (state: ExpenseState, spec: Spec, path: Event[], initial: Spec = spec) => {
    // All specification fields, including version and evidence, participate in
    // identity. This is not a coarse abstraction that merges different actors.
    const key = JSON.stringify(spec, (_key, value: unknown) => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    if (!seen.has(key)) { seen.add(key); queue.push({ actual: state, spec, initial, path }); }
  };
  for (const amount of amounts) for (const receipt of [false, true]) {
    const draft = draftExpense({ id: 'expense', owner: 'owner', amount, receipt }); assert(draft.ok);
    enqueue(draft.value, { id: 'expense', owner: 'owner', amount, receipt, version: 1, kind: 'draft' }, []);
  }
  let edges = 0, failures = 0;
  const reached = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const entry = queue[cursor]!; reached.add(entry.spec.kind);
    if (entry.path.length >= depthLimit) continue;
    for (const event of events) {
      const path = [...entry.path, event], context = JSON.stringify({ initial: entry.initial, path });
      const before = JSON.stringify(entry.actual), expected = reference(entry.spec, event), result = actual(entry.actual, event);
      edges++;
      assert.equal(JSON.stringify(entry.actual), before, context);
      if ('error' in expected) {
        failures++; assert(!result.ok, context);
        assert.equal(result.error.kind, expected.error, context); continue;
      }
      assert(result.ok, context); assert.deepEqual(result.value.next, expected.next, context);
      assert(validExpenseChange(entry.actual, result.value.next, entry.actual.version), context);
      assert.deepEqual(restoreExpense(result.value.next), { ok: true, value: result.value.next }, context);
      enqueue(result.value.next, expected.next, path, entry.initial);
    }
  }
  assert.deepEqual([...reached].sort(), ['approved', 'draft', 'finance', 'manager', 'rejected', 'returned']);
  assert(queue.some(entry => entry.path.filter(event => event.type === 'submit').length >= 2));
  assert(queue.some(entry => entry.path.filter(event => event.type === 'return').length >= 2));
  t.diagnostic(JSON.stringify({ depthLimit, reachableStates: queue.length, checkedEdges: edges, rejectedEdges: failures, eventsPerState: events.length }));
  assert(edges > 1000 && failures > 1000);
});
