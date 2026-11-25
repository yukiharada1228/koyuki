import test from 'node:test';
import assert from 'node:assert/strict';
import { foldEach, business, ok, err, type Result, type Rule } from './framework/index.js';

test('dependent reductions use the preceding state and stop at the original first failure', () => {
  const visited: number[] = [], failure = { kind: 'InsufficientBudget' as const, index: 1 };
  const folded = foldEach(() => 10, (remaining, amount: number, index): Result<number, typeof failure> => {
    visited.push(index); return amount > remaining ? err(failure) : ok(remaining - amount);
  });
  assert.deepEqual(visited, []);
  const result = folded([6, 5, 1]);
  assert(!result.ok); assert.equal(result.error, failure); assert.deepEqual(visited, [0, 1]);
  assert.deepEqual(folded([6, 4]), ok(0));
});

test('every invocation has a fresh initial state, including empty input', () => {
  let initialized = 0;
  const folded = foldEach((): readonly string[] => { initialized++; return []; }, (state, item: string) => ok([...state, item]));
  assert.equal(initialized, 0);
  const first = folded(['a']), second = folded(['b']), empty = folded([]);
  assert.deepEqual(first, ok(['a'])); assert.deepEqual(second, ok(['b'])); assert.deepEqual(empty, ok([]));
  assert.equal(initialized, 3);
});

test('positions are snapshotted and thrown defects are not converted to business errors', () => {
  const input = [1, 2, 3];
  const sum = foldEach(() => 0, (state, item: number) => { input.splice(1); return ok(state + item); });
  assert.deepEqual(sum(input), ok(6));
  const defect = new Error('defect');
  let calls = 0;
  const broken = foldEach(() => 0, (state, item: number) => { calls++; if (item === 2) throw defect; return ok(state + item); });
  assert.throws(() => broken([1, 2, 3]), error => error === defect); assert.equal(calls, 2);
  const brokenInitial = foldEach((): number => { throw defect; }, (state, _item: number) => ok(state));
  assert.throws(() => brokenInitial([]), error => error === defect);
});

interface Allocation { readonly remaining: number; readonly granted: readonly number[] }
type BudgetError = { readonly kind: 'InvalidAmount' | 'InsufficientBudget'; readonly index: number };
function allocate(state: Allocation, amount: number, index: number): Result<Allocation, BudgetError> {
  if (!Number.isSafeInteger(amount) || amount <= 0) return err({ kind: 'InvalidAmount', index });
  if (amount > state.remaining) return err({ kind: 'InsufficientBudget', index });
  return ok({ remaining: state.remaining - amount, granted: [...state.granted, amount] });
}
const allocateRequests = foldEach((): Allocation => ({ remaining: 10, granted: [] }), allocate);
test('dependent budget allocation connects to business and never saves a partial calculation', async () => {
  const saved: Allocation[] = [];
  const budget = business({ name: 'budget.v1', load: async (amounts: readonly number[]) => ok(amounts),
    save: async (value: Allocation) => { saved.push(value); return ok(value); }, operations: { allocate: [allocateRequests] } });
  const rejected = await budget.allocate.runDetailed([6, 5, 1]);
  assert.deepEqual(rejected.result, err({ kind: 'InsufficientBudget', index: 1 }));
  assert.deepEqual(rejected.trace.map(t => t.status), ['ok', 'error']); assert.equal(saved.length, 0);
  assert.deepEqual(await budget.allocate([6, 4]), ok({ remaining: 0, granted: [6, 4] }));
  assert.deepEqual(await budget.allocate([1]), ok({ remaining: 9, granted: [1] }));
  assert.equal(saved.length, 2);
});

const exact: Rule<readonly number[], Allocation, BudgetError> = allocateRequests;
void exact;
if (false) {
  // @ts-expect-error every item is a number
  allocateRequests(['bad']);
  // @ts-expect-error a reducer must accept every initial state
  foldEach(() => 'any' as string, (_state: 'approved', item: number) => ok(String(item)));
  // @ts-expect-error asynchronous reducers belong at an explicit IO boundary
  foldEach(() => 0, async (state, item: number) => ok(state + item));
  // @ts-expect-error a step cannot silently change the accumulator type
  foldEach(() => 0, (_state, item: number) => ok(String(item)));
}
