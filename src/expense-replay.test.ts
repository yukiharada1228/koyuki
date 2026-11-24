import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { err, type Result, type Execution } from './framework/index.js';
import { ReplaySqliteExpenses, type ExpenseRequest, type ReplayStorageError } from './expenses/sqlite-replay.js';
import { expenseReplayCommands, expenseReplayApplication } from './expenses/replay.js';
import { draftExpense, type Actor, type ExpenseState, type Change } from './expenses/domain.js';
function value<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
const employee: Actor = { id: 'owner', role: 'employee', active: true }, manager: Actor = { id: 'boss', role: 'manager', active: true }, finance: Actor = { id: 'accountant', role: 'finance', active: true };
const call = (requestId: string, expectedVersion = 1) => ({ requestId, input: { id: 'e1', expectedVersion } });
function fixture(t: { after(fn: () => void): void }, amount = 200000) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-expense-replay-')), path = join(dir, 'db.sqlite');
  const repository = new ReplaySqliteExpenses(path);
  value(repository.insertDraft(value(draftExpense({ id: 'e1', owner: 'owner', amount, receipt: true }))));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, repository, employee: expenseReplayCommands(repository, employee), manager: expenseReplayCommands(repository, manager), finance: expenseReplayCommands(repository, finance) };
}
test('expense domain is unchanged: submission and two approvals commit then replay', async t => {
  const f = fixture(t);
  for (const [command, request, kind] of [[f.employee.submit, call('submit'), 'manager'], [f.manager.approve, call('manager', 2), 'finance'], [f.finance.approve, call('finance', 3), 'approved']] as const) {
    const first = value(await command.run(request)); assert.equal(first.kind, 'committed'); assert.equal(first.value.kind, kind);
    const second = value(await command.run(request)); assert.equal(second.kind, 'replayed'); assert.deepEqual(second.value, first.value);
  }
  assert.equal(value(f.repository.read('e1')).version, 4);
});
test('rejection replay keeps original reason and rejects reuse with changed reason', async t => {
  const f = fixture(t); value(await f.employee.submit.run(call('submit')));
  const request = { requestId: 'reject', input: { id: 'e1', expectedVersion: 2, reason: 'policy' } };
  const first = value(await f.manager.reject.run(request)); assert.equal(first.kind, 'committed'); assert.equal(first.value.kind, 'rejected');
  const replay = value(await f.manager.reject.run(request)); assert.equal(replay.kind, 'replayed'); assert.deepEqual(first.value, replay.value);
  assert.deepEqual(await f.manager.reject.run({ ...request, input: { ...request.input, reason: 'different' } }), err({ kind: 'IdempotencyConflict' }));
});
test('successful receipts are bound to trusted identity, role, status, operation and exact input', async t => {
  const f = fixture(t); value(await f.employee.submit.run(call('key')));
  for (const actor of [{ ...employee, id: 'intruder' }, { ...employee, role: 'manager' as const }, { ...employee, active: false }]) {
    assert.deepEqual(await expenseReplayCommands(f.repository, actor).submit.run(call('key')), err({ kind: 'IdempotencyConflict' }));
  }
  assert.deepEqual(await f.employee.approve.run(call('key')), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(await f.employee.submit.run(call('key', 2)), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(await f.employee.submit.run({ requestId: 'key', input: { id: 'other', expectedVersion: 1 } }), err({ kind: 'IdempotencyConflict' }));
});
test('permission failures never create receipts or reduce business state', async t => {
  const f = fixture(t), denied = await f.manager.submit.run(call('denied'));
  assert.deepEqual(denied, err({ kind: 'Forbidden' })); assert.equal(value(f.repository.read('e1')).kind, 'draft');
  assert.deepEqual(f.repository.receipt({ operation: 'submit', actor: manager, ...call('denied') }), { ok: true, value: { kind: 'missing' } });
  assert.deepEqual(await f.employee.submit.run(call('')), err({ kind: 'InvalidRequest' }));
});
test('replaying an old expense submission cannot rewind an up-to-date application view', async t => {
  const f = fixture(t);
  const original = value(await f.employee.submit.run(call('submit'))); value(await f.manager.approve.run(call('manager', 2))); value(await f.finance.approve.run(call('finance', 3)));
  const session = await expenseReplayApplication(f.repository, employee, value(f.repository.list())).start();
  await session.dispatch({ type: 'submit', input: call('submit') });
  assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().view.expenses[0]?.kind, 'approved');
  const replay = value(await f.employee.submit.run(call('submit'))); assert.equal(replay.kind, 'replayed'); assert.deepEqual(replay.value, original.value);
  assert.equal(value(f.repository.read('e1')).kind, 'approved');
});
test('separate connections submitting the same request produce one commit and one replay', async t => {
  const f = fixture(t), other = new ReplaySqliteExpenses(f.path); t.after(() => other.close());
  const results = await Promise.all([f.employee.submit.run(call('same')), expenseReplayCommands(other, employee).submit.run(call('same'))]);
  const outputs = results.map(value); assert.deepEqual(outputs.map(x => x.kind).sort(), ['committed', 'replayed']);
  assert.deepEqual(outputs[0]!.value, outputs[1]!.value); assert.equal(value(f.repository.read('e1')).version, 2);
});
test('separate requests with a stale snapshot cannot both change the same expense', async t => {
  const f = fixture(t), other = new ReplaySqliteExpenses(f.path); t.after(() => other.close());
  const results = await Promise.all([f.employee.submit.run(call('a')), expenseReplayCommands(other, employee).submit.run(call('b'))]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.deepEqual(results.find(x => !x.ok), err({ kind: 'SaveConflict' })); assert.equal(value(f.repository.read('e1')).version, 2);
});
test('receipt insertion failure rolls back expense, change history and receipt together', async t => {
  const f = fixture(t), admin = new DatabaseSync(f.path); t.after(() => admin.close());
  admin.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON expense_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.deepEqual(await f.employee.submit.run(call('retry')), err({ kind: 'RepositoryUnavailable' }));
  assert.equal(value(f.repository.read('e1')).version, 1);
  assert.equal(admin.prepare('SELECT count(*) AS n FROM expense_changes').get()?.n, 0);
  assert.equal(admin.prepare('SELECT count(*) AS n FROM expense_receipts').get()?.n, 0);
  admin.exec('DROP TRIGGER fail_receipt'); assert.equal(value(await f.employee.submit.run(call('retry'))).kind, 'committed');
});
test('an unknown commit result is resolved using the atomic success receipt', async t => {
  const f = fixture(t);
  class LostResponse extends ReplaySqliteExpenses {
    override async saveRequest(request: ExpenseRequest, change: Change): Promise<Result<Execution<ExpenseState>, ReplayStorageError>> {
      const result = await super.saveRequest(request, change);
      return result.ok ? err({ kind: 'RepositoryUnavailable' }) : result;
    }
  }
  const other = new LostResponse(f.path); t.after(() => other.close());
  const result = value(await expenseReplayCommands(other, employee).submit.run(call('lost')));
  assert.equal(result.kind, 'replayed'); assert.equal(result.value.kind, 'manager'); assert.equal(value(f.repository.read('e1')).version, 2);
});
test('expense receipts survive a fresh process and preserve newer stored state', async t => {
  const f = fixture(t); const original = value(await f.employee.submit.run(call('submit')));
  value(await f.manager.approve.run(call('manager', 2)));
  const code = `import {ReplaySqliteExpenses} from './src/expenses/sqlite-replay.ts'; import {expenseReplayCommands} from './src/expenses/replay.ts'; const r=new ReplaySqliteExpenses(${JSON.stringify(f.path)}); try { console.log(JSON.stringify(await expenseReplayCommands(r,${JSON.stringify(employee)}).submit.run(${JSON.stringify(call('submit'))}))); } finally {r.close();}`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { ok: true, value: { kind: 'replayed', value: original.value } });
  assert.equal(value(f.repository.read('e1')).kind, 'finance');
});
test('corrupted expense receipt fails hydration rather than returning an unvalidated success', async t => {
  const f = fixture(t); value(await f.employee.submit.run(call('submit')));
  const admin = new DatabaseSync(f.path); t.after(() => admin.close());
  admin.prepare('UPDATE expense_receipts SET result_json=?').run(JSON.stringify({ id: 'e1', kind: 'approved' }));
  assert.deepEqual(await f.employee.submit.run(call('submit')), err({ kind: 'CorruptExpense' }));
});
test('request nested input is captured before async replay lookup and command invocation', async t => {
  const f = fixture(t), request = call('snapshot');
  const pending = f.employee.submit.run(request); request.requestId = 'changed'; request.input.expectedVersion = 99;
  assert.equal(value(await pending).kind, 'committed'); assert.equal(value(await f.employee.submit.run(call('snapshot'))).kind, 'replayed');
});
