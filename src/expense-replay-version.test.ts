import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { err } from './framework/index.js';
import { ReplaySqliteExpenses, type ExpenseRequest } from './expenses/sqlite-replay.js';
import { expenseReplayCommands } from './expenses/replay.js';
import { draftExpense, type Actor } from './expenses/domain.js';

const actor: Actor = { id: 'owner', role: 'employee', active: true };
const input = { id: 'e1', expectedVersion: 1 };
const call = { requestId: 'same-id', input };
const request: ExpenseRequest = { operation: 'submit', actor, ...call };
function location(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-receipt-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'db.sqlite');
}
function seed(repository: ReplaySqliteExpenses) {
  const draft = draftExpense({ id: 'e1', owner: actor.id, amount: 200000, receipt: true });
  assert(draft.ok); assert(repository.insertDraft(draft.value).ok);
}

test('default receipts keep their legacy fingerprint and a changed host definition rejects their ID', async t => {
  const path = location(t), original = new ReplaySqliteExpenses(path);
  seed(original);
  const saved = await expenseReplayCommands(original, actor).submit.run(call);
  assert(saved.ok && saved.value.kind === 'committed'); original.close();
  const db = new DatabaseSync(path);
  const legacy = createHash('sha256').update(JSON.stringify(['expenses.v1', 'submit', 'owner', 'employee', true, 'e1', 1, null])).digest('hex');
  assert.equal(db.prepare('SELECT fingerprint FROM expense_receipts').get()?.fingerprint, legacy);
  const options = { definitionVersion: 'expenses.v2' }, current = new ReplaySqliteExpenses(path, options);
  options.definitionVersion = 'expenses.v1'; // Host option ownership is fixed at construction.
  const old = new ReplaySqliteExpenses(path);
  try {
    const forged = { ...call, definitionVersion: 'expenses.v1' };
    assert.deepEqual(await expenseReplayCommands(current, actor).submit.run(forged), err({ kind: 'IdempotencyConflict' }));
    assert.deepEqual(current.receipt(request), err({ kind: 'IdempotencyConflict' }));
    const replay = await expenseReplayCommands(old, actor).submit.run(call);
    assert(replay.ok && replay.value.kind === 'replayed'); assert.deepEqual(replay.value.value, saved.value.value);
    const boss: Actor = { id: 'boss', role: 'manager', active: true };
    const next = { requestId: 'new-operation', input: { id: 'e1', expectedVersion: 2 } };
    const approved = await expenseReplayCommands(current, boss).approve.run(next);
    assert(approved.ok && approved.value.kind === 'committed');
    assert.deepEqual(old.receipt({ operation: 'approve', actor: boss, ...next }), err({ kind: 'IdempotencyConflict' }));
    const repeated = await expenseReplayCommands(current, boss).approve.run(next);
    assert(repeated.ok && repeated.value.kind === 'replayed');
    assert.equal(db.prepare('SELECT count(*) n FROM expense_receipts').get()?.n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM expense_changes').get()?.n, 2);
  } finally { db.close(); old.close(); current.close(); }
});

test('concurrent hosts with different definitions cannot both commit the same request ID', async t => {
  const path = location(t), first = new ReplaySqliteExpenses(path), second = new ReplaySqliteExpenses(path, { definitionVersion: 'expenses.v2' });
  seed(first);
  try {
    const results = await Promise.all([expenseReplayCommands(first, actor).submit.run(call), expenseReplayCommands(second, actor).submit.run(call)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok), err({ kind: 'IdempotencyConflict' }));
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare('SELECT count(*) n FROM expense_receipts').get()?.n, 1);
      assert.equal(db.prepare('SELECT count(*) n FROM expense_changes').get()?.n, 1);
      const state = first.read('e1'); assert(state.ok); assert.equal(state.value.version, 2);
    } finally { db.close(); }
  } finally { first.close(); second.close(); }
});

test('invalid definition versions fail before opening a database', t => {
  const path = location(t);
  for (const definitionVersion of ['', ' v2', 'v2 ', 'x'.repeat(201), null as unknown as string]) {
    assert.throws(() => new ReplaySqliteExpenses(path, { definitionVersion }), { message: 'InvalidExpenseDefinitionVersion' });
    assert.equal(existsSync(path), false);
  }
});
