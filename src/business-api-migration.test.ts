import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { err, type Result } from './framework/index.js';
import { expenseReplayCommands } from './expenses/replay.js';
import { expenseBusinessCommands } from './experiments/expense-business.js';
import { ReplaySqliteExpenses } from './expenses/sqlite-replay.js';
import { draftExpense, type Actor } from './expenses/domain.js';
const employee: Actor = { id: 'owner', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };
function value<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
test('old and new expense declarations share durable receipts across process restart and all five operations', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-business-migration-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = new ReplaySqliteExpenses(path);
  const input = { requestId: 'submit-old', input: { id: 'one', expectedVersion: 1 } };
  let original;
  try {
    value(initial.insertDraft(value(draftExpense({ id: 'one', owner: 'owner', amount: 5000, receipt: true }))));
    original = value(await expenseReplayCommands(initial, employee).submit.run(input));
  } finally { initial.close(); }
  // New declarations in a fresh OS process must replay an old committed receipt.
  const code = `import {ReplaySqliteExpenses} from './src/expenses/sqlite-replay.ts'; import {expenseBusinessCommands} from './src/experiments/expense-business.ts'; const r=new ReplaySqliteExpenses(${JSON.stringify(path)}); try {console.log(JSON.stringify(await expenseBusinessCommands(r,${JSON.stringify(employee)}).submit(${JSON.stringify(input)})));} finally {r.close();}`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, value: { kind: 'replayed', value: original.value } });
  const repository = new ReplaySqliteExpenses(path), admin = new DatabaseSync(path);
  try {
    const owner = expenseBusinessCommands(repository, employee), boss = expenseBusinessCommands(repository, manager);
    const returned = await boss.return.runDetailed({ requestId: 'return-new', input: { id: 'one', expectedVersion: 2, reason: 'fix' } });
    assert(returned.result.ok); assert.equal(returned.result.value.kind, 'committed');
    assert.deepEqual(returned.attempt?.trace?.map(step => step.step), ['expense.return.v1:load', 'run:1', 'run:2', 'expense.return.v1']);
    const edit = { requestId: 'edit-new', input: { id: 'one', expectedVersion: 3, amount: 6000, receipt: true } };
    const edited = value(await owner.edit(edit)); assert.equal(edited.kind, 'committed');
    // Old declarations also replay receipts produced by the new ordinary-function declaration.
    assert.deepEqual(value(await expenseReplayCommands(repository, employee).edit.run(edit)), { kind: 'replayed', value: edited.value });
    value(await owner.submit({ requestId: 'submit-new', input: { id: 'one', expectedVersion: 4 } }));
    value(await boss.approve({ requestId: 'approve-new', input: { id: 'one', expectedVersion: 5 } }));
    assert.equal(value(repository.read('one')).kind, 'approved');
    assert.deepEqual(value(await owner.submit(input)), { kind: 'replayed', value: original.value });
    assert.equal(value(repository.read('one')).version, 6);
    assert.equal(admin.prepare('SELECT count(*) AS n FROM expense_changes').get()?.n, 5);
    assert.equal(admin.prepare('SELECT count(*) AS n FROM expense_receipts').get()?.n, 5);
    assert.deepEqual(await owner.edit({ ...edit, input: { ...edit.input, amount: 7000 } }), err({ kind: 'IdempotencyConflict' }));
    assert.deepEqual(await boss.submit(input), err({ kind: 'IdempotencyConflict' }));
    // Exercise the fifth operation on another real aggregate, including replay from the old API.
    value(repository.insertDraft(value(draftExpense({ id: 'two', owner: 'owner', amount: 5000, receipt: true }))));
    value(await owner.submit({ requestId: 'second', input: { id: 'two', expectedVersion: 1 } }));
    const reject = { requestId: 'reject-new', input: { id: 'two', expectedVersion: 2, reason: 'policy' } };
    const rejected = value(await boss.reject(reject));
    assert.equal(rejected.value.kind, 'rejected');
    assert.deepEqual(value(await expenseReplayCommands(repository, manager).reject.run(reject)), { kind: 'replayed', value: rejected.value });
  } finally { admin.close(); repository.close(); }
});
