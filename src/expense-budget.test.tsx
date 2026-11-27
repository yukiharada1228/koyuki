/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, err } from './framework/index.js';
import { h, Fragment, createApplicationTemplate } from './framework/authoring.js';
import { draftExpense, type Actor } from './expenses/domain.js';
import { decide, parseRequest } from './experiments/expense-budget/domain.js';
import { BudgetSqliteExpenses } from './experiments/expense-budget/sqlite.js';
import { executePlain } from './experiments/expense-budget/plain.js';
import { ExpenseBusiness, ExpenseNotifications, ActorContext, submission, approval, correction, editing } from './experiments/expense-budget/application.js';
import type { Repository } from './experiments/expense-budget/repository.js';
const employee: Actor = { id: 'alice', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };
const finance: Actor = { id: 'accountant', role: 'finance', active: true };
function draft(id: string, amount = 200000) { const value = draftExpense({ id, owner: employee.id, amount, receipt: true }); assert(value.ok); return value.value; }
function setup(repository: Repository, send = async () => ok(null)) {
  const template = createApplicationTemplate(<Fragment><ExpenseBusiness repository={repository} /><ExpenseNotifications sink={{ send }} /></Fragment>);
  return (actor: Actor) => template.scope(children => <ActorContext.Provider value={actor}>{children}</ActorContext.Provider>);
}
function store() { const db = new BudgetSqliteExpenses(':memory:'); db.seed([draft('one'), draft('two')], { id: 'engineering', available: 300000, version: 1 }); return db; }
test('multi-stage approval, budget release and resubmission use the existing expense model', async () => {
  const db = store();
  try {
    const app = setup(db);
    const submitted = await app(employee).execute(submission, { id: 'one', expectedVersion: 1, requestId: 'submit' });
    assert(submitted.ok && submitted.value.value.kind === 'manager');
    assert.equal(db.snapshot().budget.available, 100000);
    const other = await app(employee).execute(submission, { id: 'two', expectedVersion: 1, requestId: 'exceeds' });
    assert.deepEqual(other, err({ kind: 'BudgetExceeded' }));
    const approved = await app(manager).execute(approval, { id: 'one', expectedVersion: 2, requestId: 'manager' });
    assert(approved.ok && approved.value.value.kind === 'finance');
    const returned = await app(finance).execute(correction, { id: 'one', expectedVersion: 3, requestId: 'return', reason: 'Receipt correction' });
    assert(returned.ok && returned.value.value.kind === 'returned');
    assert.equal(db.snapshot().budget.available, 300000);
    const edited = await app(employee).execute(editing, { id: 'one', expectedVersion: 4, requestId: 'edit', amount: 150000, receipt: true });
    assert(edited.ok && edited.value.value.kind === 'draft');
    assert((await app(employee).execute(submission, { id: 'one', expectedVersion: 5, requestId: 'resubmit' })).ok);
    assert((await app(manager).execute(approval, { id: 'one', expectedVersion: 6, requestId: 'manager-again' })).ok);
    const final = await app(finance).execute(approval, { id: 'one', expectedVersion: 7, requestId: 'finance' });
    assert(final.ok && final.value.value.kind === 'approved');
    assert.equal(db.snapshot().budget.available, 150000);
    assert.equal(db.snapshot().receipts, 7); assert.equal(db.auditCount(), 7);
    assert.equal(db.snapshot().events.length, 7);
    const snapshot = db.snapshot();
    const replay = await app(employee).execute(submission, { id: 'one', expectedVersion: 1, requestId: 'submit' });
    assert(replay.ok && replay.value.kind === 'replayed' && replay.value.value.kind === 'manager');
    assert.deepEqual(db.snapshot(), snapshot);
  } finally { db.close(); }
});

test('stale parallel expenses cannot overspend a shared budget', async () => {
  const db = store();
  try {
    // Both computations see the same old budget; the save boundary must arbitrate.
    const one = await db.load({ id: 'one', expectedVersion: 1, requestId: 'one' }, employee);
    const two = await db.load({ id: 'two', expectedVersion: 1, requestId: 'two' }, employee);
    assert(one.ok && two.ok);
    const before = structuredClone(one.value), a = decide('submit', one.value), b = decide('submit', two.value);
    assert(a.ok && b.ok); assert.deepEqual(one.value, before);
    const results = await Promise.all([db.save(a.value, one.value.input, { action: 'submit', actor: employee }, []), db.save(b.value, two.value.input, { action: 'submit', actor: employee }, [])]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.deepEqual(results.find(r => !r.ok), err({ kind: 'Conflict' }));
    assert.equal(db.snapshot().budget.available, 100000); assert.equal(db.auditCount(), 1);
  } finally { db.close(); }
});

test('failure at each transaction tail rolls back expense, budget, audit, events and receipt together', async () => {
  for (const table of ['outbox', 'audit', 'receipts']) {
    const db = store();
    try {
      db.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
      const before = db.snapshot();
      let notifications = 0;
      const result = await setup(db, async () => { notifications++; return ok(null); })(employee).execute(submission, { id: 'one', expectedVersion: 1, requestId: 'rollback' });
      assert.equal(notifications, 0);
      assert.deepEqual(result, err({ kind: 'StorageFailed' })); assert.deepEqual(db.snapshot(), before); assert.equal(db.auditCount(), 0);
      db.db.exec('DROP TRIGGER fail_insert');
      assert((await setup(db)(employee).execute(submission, { id: 'one', expectedVersion: 1, requestId: 'rollback' })).ok);
    } finally { db.close(); }
  }
});

test('durable replay survives response loss, delivery failure and database reconnection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-expense-budget-')), path = join(dir, 'expenses.sqlite');
  let db = new BudgetSqliteExpenses(path), sends = 0;
  try {
    db.seed([draft('one')], { id: 'engineering', available: 300000, version: 1 });
    const template = setup(db, async () => { sends++; throw new Error('offline'); });
    const input = { id: 'one', expectedVersion: 1, requestId: 'lost' };
    const committed = await template(employee).executeDetailed(submission, input);
    assert(committed.result.ok); assert.equal(committed.deliveries[0]?.status, 'defect');
    assert(committed.attempt?.trace?.some(row => row.step === 'validate-submission'));
    assert(committed.attempt?.trace?.some(row => row.step === 'allocate-budget'));
    // The client loses this response. A fresh application uses the persisted receipt.
    db.close(); db = new BudgetSqliteExpenses(path);
    const reopened = setup(db, async () => { sends++; return ok(null); })(employee);
    const replay = await reopened.executeDetailed(submission, input);
    assert(replay.result.ok && replay.result.value.kind === 'replayed'); assert.equal(replay.attempt, null);
    assert.equal(sends, 1); assert.equal(db.snapshot().budget.available, 100000);
    await reopened.deliver(db.snapshot().events[0]!);
    assert.equal(sends, 2); assert.equal(db.auditCount(), 1);
    const conflict = await reopened.execute(submission, { ...input, id: 'other' });
    assert.deepEqual(conflict, err({ kind: 'IdempotencyConflict' }));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('plain TypeScript and Koyuki produce the same state, budget, receipts and audit for a shared scenario', async () => {
  const plain = store(), declarative = store();
  try {
    const app = setup(declarative);
    const first = { id: 'one', expectedVersion: 1, requestId: 'submit' };
    assert.deepEqual(await executePlain(plain, employee, 'submit', first, async () => {}), await app(employee).execute(submission, first));
    const next = { id: 'one', expectedVersion: 2, requestId: 'approve' };
    assert.deepEqual(await executePlain(plain, manager, 'approve', next, async () => {}), await app(manager).execute(approval, next));
    assert.deepEqual(await executePlain(plain, employee, 'submit', first, async () => {}), await app(employee).execute(submission, first));
    const tooLarge = { id: 'two', expectedVersion: 1, requestId: 'over-budget' };
    assert.deepEqual(await executePlain(plain, employee, 'submit', tooLarge, async () => {}), await app(employee).execute(submission, tooLarge));
    const returned = { id: 'one', expectedVersion: 3, requestId: 'return', reason: 'Correct receipt' };
    assert.deepEqual(await executePlain(plain, finance, 'return', returned, async () => {}), await app(finance).execute(correction, returned));
    const edit = { id: 'one', expectedVersion: 4, requestId: 'edit', amount: 150000, receipt: true };
    assert.deepEqual(await executePlain(plain, employee, 'edit', edit, async () => {}), await app(employee).execute(editing, edit));
    const resubmit = { id: 'one', expectedVersion: 5, requestId: 'resubmit' };
    assert.deepEqual(await executePlain(plain, employee, 'submit', resubmit, async () => {}), await app(employee).execute(submission, resubmit));
    const reapprove = { id: 'one', expectedVersion: 6, requestId: 'reapprove' };
    assert.deepEqual(await executePlain(plain, manager, 'approve', reapprove, async () => {}), await app(manager).execute(approval, reapprove));
    const final = { id: 'one', expectedVersion: 7, requestId: 'finance' };
    assert.deepEqual(await executePlain(plain, finance, 'approve', final, async () => {}), await app(finance).execute(approval, final));
    const normalize = (db: BudgetSqliteExpenses) => { const snap = db.snapshot(); return { ...snap, events: snap.events.map(({ type, payload }) => ({ type, payload })) }; };
    assert.deepEqual(normalize(plain), normalize(declarative)); assert.equal(plain.auditCount(), declarative.auditCount());
    if (false) {
      // @ts-expect-error Returning requires a reason.
      void app(manager).execute(correction, { id: 'one', expectedVersion: 2, requestId: 'missing-reason' });
      // @ts-expect-error Editing requires both amount and receipt.
      void app(employee).execute(editing, first);
    }
    assert(!parseRequest('edit', { ...first, amount: 'bad', receipt: true }).ok);
  } finally { plain.close(); declarative.close(); }
});

test('the same adapter contract protects budget CAS, receipts and detached snapshots in memory and SQLite', async () => {
  const { MemoryBudgetExpenses } = await import('./experiments/expense-budget/memory.js');
  const factories = [() => new MemoryBudgetExpenses([draft('one'), draft('two')], { id: 'engineering', available: 300000, version: 1 }), store];
  for (const create of factories) {
    const db = create();
    try {
      const { checkRepositoryContract } = await import('./experiments/expense-budget/contracts.js');
      await checkRepositoryContract(db, employee, { id: 'one', expectedVersion: 1, requestId: 'adapter-contract' }, assert);
    } finally { db.close(); }
  }
});

test('a changed budget revision conflicts even if the remaining money is unchanged', async () => {
  const db = store();
  try {
    const request = { id: 'one', expectedVersion: 1, requestId: 'budget-revision' };
    const loaded = await db.load(request, employee); assert(loaded.ok);
    const change = decide('submit', loaded.value); assert(change.ok);
    db.db.prepare('UPDATE budgets SET data=?').run(JSON.stringify({ ...loaded.value.budget, version: 2 }));
    const before = db.snapshot();
    assert.deepEqual(await db.save(change.value, request, { action: 'submit', actor: employee }, []), err({ kind: 'Conflict' }));
    assert.deepEqual(db.snapshot(), before);
  } finally { db.close(); }
});

test('finance approval threshold has independent boundary expectations in both implementations', async () => {
  const cases = [{ amount: 99999, expected: 'approved' }, { amount: 100000, expected: 'approved' }, { amount: 100001, expected: 'finance' }];
  for (const fixture of cases) {
    for (const kind of ['plain', 'koyuki']) {
      const db = new BudgetSqliteExpenses(':memory:');
      try {
        db.seed([draft('boundary', fixture.amount)], { id: 'engineering', available: 300000, version: 1 });
        const submit = { id: 'boundary', expectedVersion: 1, requestId: 'submit' };
        const approve = { id: 'boundary', expectedVersion: 2, requestId: 'approve' };
        const app = setup(db);
        assert((await (kind === 'plain' ? executePlain(db, employee, 'submit', submit, async () => {}) : app(employee).execute(submission, submit))).ok);
        const result = await (kind === 'plain' ? executePlain(db, manager, 'approve', approve, async () => {}) : app(manager).execute(approval, approve));
        assert(result.ok); assert.equal(result.value.value.kind, fixture.expected);
        assert.equal(db.snapshot().budget.available, 300000 - fixture.amount);
      } finally { db.close(); }
    }
  }
});


test('an unknown commit resolves from the durable receipt without reserving budget or notifying twice', async () => {
  const db = store(); let saves = 0, sends = 0;
  try {
    const uncertain: Repository = {
      load: db.load.bind(db), receipt: db.receipt.bind(db),
      async save(...args) { saves++; const result = await db.save(...args); return result.ok ? err({ kind: 'StorageFailed' as const }) : result; },
    };
    const app = setup(uncertain, async () => { sends++; return ok(null); })(employee);
    const result = await app.execute(submission, { id: 'one', expectedVersion: 1, requestId: 'uncertain' });
    assert(result.ok && result.value.kind === 'replayed');
    assert.equal(saves, 1); assert.equal(sends, 0);
    assert.equal(db.snapshot().budget.available, 100000); assert.equal(db.snapshot().events.length, 1); assert.equal(db.auditCount(), 1);
    await app.deliver(db.snapshot().events[0]!);
    assert.equal(sends, 1); assert.equal(saves, 1);
  } finally { db.close(); }
});

test('independent SQLite connections reject a stale shared-budget calculation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-budget-connections-')), path = join(dir, 'budget.sqlite');
  const first = new BudgetSqliteExpenses(path), second = new BudgetSqliteExpenses(path);
  try {
    first.seed([draft('one'), draft('two')], { id: 'engineering', available: 300000, version: 1 });
    const a = await first.load({ id: 'one', requestId: 'one', expectedVersion: 1 }, employee);
    const b = await second.load({ id: 'two', requestId: 'two', expectedVersion: 1 }, employee);
    assert(a.ok && b.ok);
    const x = decide('submit', a.value), y = decide('submit', b.value); assert(x.ok && y.ok);
    assert((await first.save(x.value, a.value.input, { action: 'submit', actor: employee }, [])).ok);
    assert.deepEqual(await second.save(y.value, b.value.input, { action: 'submit', actor: employee }, []), err({ kind: 'Conflict' }));
    assert.deepEqual(first.snapshot(), second.snapshot()); assert.equal(first.snapshot().budget.available, 100000);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a structurally valid receipt with a different owner fails closed', async () => {
  const db = store();
  try {
    const request = { id: 'one', expectedVersion: 1, requestId: 'corrupt-receipt' };
    const app = setup(db)(employee);
    const first = await app.execute(submission, request); assert(first.ok);
    db.db.prepare('UPDATE receipts SET data=? WHERE request_id=?').run(JSON.stringify({ ...first.value.value, owner: 'somebody-else' }), request.requestId);
    const before = db.snapshot();
    const result = await app.executeDetailed(submission, request);
    assert.deepEqual(result.result, err({ kind: 'CorruptReceipt' })); assert.equal(result.attempt, null);
    assert.deepEqual(db.snapshot(), before);
  } finally { db.close(); }
});
