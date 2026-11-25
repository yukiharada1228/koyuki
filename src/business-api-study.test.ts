import test from 'node:test';
import assert from 'node:assert/strict';
import { business } from './experiments/business.js';
import { ok, err, withInput, defineApplication, operations, replayOperations, type Result, type Execution, type Receipt, type GroupExecution } from './framework/index.js';
import { draftExpense, validateSubmission, routeSubmission, submitRouted, validateApproval, approve, validateRejection, reject, validateEdit, edit, returnForCorrection,
  type Actor, type Input, type RejectInput, type EditInput, type Change, type ExpenseState, type RuleError } from './expenses/domain.js';
import { MemoryExpenses, type LoadError, type SaveError } from './expenses/repository.js';
const employee: Actor = { id: 'owner', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };
function fixture() {
  const draft = draftExpense({ id: 'one', owner: 'owner', amount: 5000, receipt: true }); assert(draft.ok);
  return new MemoryExpenses([draft.value]);
}
function expenseBusiness(repository: MemoryExpenses, actor: Actor) {
  const identity = Object.freeze({ ...actor });
  const route = withInput(routeSubmission);
  return business({ name: 'expense.v1', load: (input: Input) => repository.load(input, identity), save: (change: Change) => repository.save(change),
    operations: {
      submit: [validateSubmission, route, submitRouted],
      approve: [validateApproval, approve],
      reject: { load: (input: RejectInput) => repository.loadReject(input, identity), run: [validateRejection, reject] },
      return: { load: (input: RejectInput) => repository.loadReject(input, identity), run: [validateRejection, returnForCorrection] },
      edit: { load: (input: EditInput) => repository.load(input, identity), run: [validateEdit, edit] },
    },
  });
}
test('ordinary function arrays cover all five expense operations without role labels', async () => {
  const repository = fixture(), owner = expenseBusiness(repository, employee), boss = expenseBusiness(repository, manager);
  assert.deepEqual(repository.calls, []);
  assert((await owner.submit({ id: 'one', expectedVersion: 1 })).ok);
  assert((await boss.return({ id: 'one', expectedVersion: 2, reason: 'fix amount' })).ok);
  assert((await owner.edit({ id: 'one', expectedVersion: 3, amount: 6000, receipt: true })).ok);
  assert((await owner.submit({ id: 'one', expectedVersion: 4 })).ok);
  assert((await boss.approve({ id: 'one', expectedVersion: 5 })).ok);
  assert.equal(repository.read('one')?.kind, 'approved');
  const second = fixture(); assert((await expenseBusiness(second, employee).submit({ id: 'one', expectedVersion: 1 })).ok);
  assert((await expenseBusiness(second, manager).reject({ id: 'one', expectedVersion: 2, reason: 'not eligible' })).ok);
  assert.equal(second.read('one')?.kind, 'rejected');
});
test('direct calls keep detailed trace and normal Application registration', async () => {
  const repository = fixture(), commands = expenseBusiness(repository, employee);
  const initial: readonly ExpenseState[] = repository.list();
  const app = await defineApplication({ initial: () => initial,
    operations: operations(commands, (before: readonly ExpenseState[], after) => before.map(value => value.id === after.id ? after : value)),
    view: state => state.data,
  }).start();
  assert((await app.dispatch({ type: 'submit', input: { id: 'one', expectedVersion: 1 } })).ok);
  assert.equal(app.snapshot().view[0]?.kind, 'manager');
  const denied = await commands.approve.runDetailed({ id: 'one', expectedVersion: 2 });
  assert(!denied.result.ok); assert.equal(denied.result.error.kind, 'SelfApproval');
  assert.deepEqual(denied.trace.map(t => t.step), ['expense.v1.approve:load', 'run:1']);
});
test('intermediate failure stops remaining rules and save with exact error inference', async () => {
  let saves = 0;
  const requireStock = (_n: number): Result<string, 'NoStock'> => err('NoStock');
  const commands = business({ name: 'stock', load: async (id: string) => ok(id.length), save: async (value: boolean) => { saves++; return ok(value); },
    operations: { reserve: [(n: number) => ok(n), requireStock, (_proof: string) => ok(true)] },
  });
  const result: Result<boolean, 'NoStock'> = await commands.reserve('a');
  assert.deepEqual(result, err('NoStock')); assert.equal(saves, 0);
  const detailed = await commands.reserve.runDetailed('a');
  assert.deepEqual(detailed.trace.map(t => t.step), ['stock.reserve:load', 'run:1', 'run:2']);
});
test('replay still requires an atomic storage boundary and does not rewind application state', async () => {
  let receipt: number | null = null, writes = 0;
  const commands = business({ name: 'counter.v1', load: async (n: number) => ok(n),
    save: async (value: number): Promise<Result<Execution<number>, never>> => { writes++; receipt = value; return ok({ kind: 'committed', value }); },
    replay: { lookup: (): Result<Receipt<number>, never> => ok(receipt === null ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: [] },
    operations: { increment: [(n: number) => ok(n + 1)] },
  });
  const first = await commands.increment(2); assert(first.ok); assert.equal(first.value.kind, 'committed');
  const second = await commands.increment(2); assert(second.ok); assert.equal(second.value.kind, 'replayed'); assert.equal(writes, 1);
  const app = await defineApplication({ initial: () => 100, operations: replayOperations(commands, (before: number, after) => before + after), view: state => state.data }).start();
  await app.dispatch({ type: 'increment', input: 2 }); assert.equal(app.snapshot().view, 100);
});
function inputTypes(commands: ReturnType<typeof expenseBusiness>) {
  if (false) {
    // @ts-expect-error operation-specific request fields must survive the shared boundary
    commands.reject({ id: 'one', expectedVersion: 1 });
    // @ts-expect-error edits require amount and receipt
    commands.edit({ id: 'one', expectedVersion: 1 });
    // @ts-expect-error common operations still require a version
    commands.approve({ id: 'one' });
    const result: Promise<Result<ExpenseState, LoadError | SaveError | RuleError>> = commands.approve({ id: 'one', expectedVersion: 1 });
    void result;
  }
}
void inputTypes;

function invalidDefinitions() {
  const load = async (n: number) => ok(n), save = async (value: string) => ok(value);
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error incompatible adjacent business rules
    wrongNext: [(n: number) => ok(true), (value: string) => ok(value)],
  } });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error final business output must match the persistence adapter
    wrongSave: [(n: number) => ok(n + 1)],
  } });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error the first rule must accept the loaded state
    wrongFirst: [(text: string) => ok(text)],
  } });
  // @ts-expect-error async effects belong to explicit adapters, not the pure rule list
  business({ name: 'bad', load, save, operations: {
    asyncRule: [async (n: number) => ok(String(n))],
  } });
  // @ts-expect-error an operation needs at least one rule
  business({ name: 'bad', load, save, operations: {
    empty: [],
  } });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error a then operation would turn the returned table into a Promise thenable
    then: [(n: number) => ok(String(n))],
  } });
  const widened: ((n: number) => Result<string, never>)[] = [n => ok(String(n))];
  // @ts-expect-error adjacency requires a tuple, not a widened arbitrary array
  business({ name: 'bad', load, save, operations: {
    widened,
  } });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error custom loader's output must match its first rule
    wrongCustom: { load: async (id: string) => ok(id), run: [(n: number) => ok(String(n))] },
  } });
  business({ name: 'bad', load, save, operations: { stringify: [(n: number) => ok(String(n))] },
    // @ts-expect-error replay needs save's atomic Execution envelope
    replay: { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: [] },
  });
}
void invalidDefinitions;

test('construction snapshots the operation rule arrays without freezing caller-owned arrays', async () => {
  let calls = 0;
  const rules: [(n: number) => Result<number, never>] = [n => { calls++; return ok(n + 1); }];
  const definition = { name: 'snapshot', load: async (n: number) => ok(n), save: async (n: number) => ok(n), operations: { change: rules } };
  const commands = business(definition);
  rules[0] = n => ok(n + 100);
  assert.equal(calls, 0); assert.equal(Object.isFrozen(rules), false);
  assert.deepEqual(await commands.change(1), ok(2)); assert.equal(calls, 1);
  assert(Object.isFrozen(commands)); assert(Object.isFrozen(commands.change));
});


test('operation and request identity reach the existing replay boundary unchanged', async () => {
  interface Request { key: string; value: number }
  type Names = 'double' | 'triple';
  type Context = GroupExecution<Names, Request>;
  const receipts = new Map<string, { operation: string; input: number; output: number }>();
  let writes = 0;
  const commands = business({ name: 'calculation.v1', load: async (input: Request) => ok(input.value),
    save: async (output: number, context: Context): Promise<Result<Execution<number>, never>> => {
      writes++; receipts.set(context.request.key, { operation: context.operation, input: context.request.value, output });
      return ok({ kind: 'committed', value: output });
    },
    replay: {
      lookup: (context: Context): Result<Receipt<number>, 'IdempotencyConflict'> => {
        const receipt = receipts.get(context.request.key);
        return !receipt ? ok({ kind: 'missing' }) : receipt.operation === context.operation && receipt.input === context.request.value
          ? ok({ kind: 'found', value: receipt.output }) : err('IdempotencyConflict');
      }, resolveAfter: [],
    },
    operations: { double: [(n: number) => ok(n * 2)], triple: [(n: number) => ok(n * 3)] },
  });
  const input = { key: 'first', value: 2 };
  const pending = commands.double(input); input.value = 99;
  assert.deepEqual(await pending, ok({ kind: 'committed', value: 4 }));
  assert.deepEqual(await commands.double({ key: 'first', value: 2 }), ok({ kind: 'replayed', value: 4 }));
  assert.deepEqual(await commands.double({ key: 'first', value: 3 }), err('IdempotencyConflict'));
  assert.deepEqual(await commands.triple({ key: 'first', value: 2 }), err('IdempotencyConflict'));
  assert.equal(writes, 1); assert.equal(receipts.get('first')?.operation, 'calculation.v1.double');
});


test('an operation named then cannot accidentally make the business object a Promise thenable', () => {
  assert.throws(() => Reflect.apply(business, undefined, [{ name: 'reserved', load: async (n: number) => ok(n), save: async (n: number) => ok(n), operations: { then: [(n: number) => ok(n)] } }]), /ReservedBusinessOperation:then/);
});
