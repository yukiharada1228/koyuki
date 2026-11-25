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
import { draftExpense, validateEdit, edit, type Actor, type ExpenseState, type Change } from './expenses/domain.js';
function value<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
const employee: Actor = { id: 'owner', role: 'employee', active: true }, manager: Actor = { id: 'boss', role: 'manager', active: true }, finance: Actor = { id: 'accountant', role: 'finance', active: true };
const call = (requestId: string, expectedVersion = 1) => ({ requestId, input: { id: 'e1', expectedVersion } });
function fixture(t: { after(fn: () => void): void }, amount = 200000, receipt = true) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-expense-replay-')), path = join(dir, 'db.sqlite');
  const repository = new ReplaySqliteExpenses(path);
  value(repository.insertDraft(value(draftExpense({ id: 'e1', owner: 'owner', amount, receipt }))));
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

test('return, edit and resubmit change approval route without resetting optimistic version', async t => {
  const f = fixture(t);
  value(await f.employee.submit.run(call('submit')));
  const returned = { ...call('return', 2), input: { ...call('return', 2).input, reason: 'correct amount' } };
  assert.equal(value(await f.manager.return.run(returned)).value.kind, 'returned');
  const edit = { ...call('edit', 3), input: { ...call('edit', 3).input, amount: 2000, receipt: false } };
  const revised = value(await f.employee.edit.run(edit));
  assert.equal(revised.value.kind, 'draft'); assert.equal(revised.value.version, 4);
  const approved = value(await f.employee.submit.run(call('resubmit', 4)));
  assert.equal(approved.value.kind, 'approved'); assert.equal(approved.value.version, 5);
  assert.equal(value(await f.employee.edit.run(edit)).kind, 'replayed');
  assert.equal(value(await f.manager.return.run(returned)).kind, 'replayed');
  assert.equal(value(f.repository.read('e1')).kind, 'approved');
  assert.deepEqual(await f.employee.edit.run({ ...edit, input: { ...edit.input, amount: 2001 } }), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(await f.employee.edit.run({ ...edit, input: { ...edit.input, receipt: true } }), err({ kind: 'IdempotencyConflict' }));
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('SELECT count(*) AS n FROM expense_changes').get()!.n, 4);
  db.close();
  const reopened = new ReplaySqliteExpenses(f.path);
  assert.equal(value(reopened.read('e1')).version, 5); reopened.close();
});

test('finance return can repeat with fresh manager evidence after correction', async t => {
  const f = fixture(t);
  value(await f.employee.submit.run(call('submit')));
  value(await f.manager.approve.run(call('manager', 2)));
  value(await f.finance.return.run({ ...call('return', 3), input: { ...call('return', 3).input, reason: 'receipt' } }));
  value(await f.employee.edit.run({ ...call('edit', 4), input: { ...call('edit', 4).input, amount: 150000, receipt: true } }));
  value(await f.employee.submit.run(call('submit-2', 5)));
  value(await f.manager.return.run({ ...call('return-2', 6), input: { ...call('return-2', 6).input, reason: 'again' } }));
  value(await f.employee.edit.run({ ...call('edit-2', 7), input: { ...call('edit-2', 7).input, amount: 150000, receipt: true } }));
  value(await f.employee.submit.run(call('submit-3', 8)));
  value(await f.manager.approve.run(call('manager-3', 9)));
  const final = value(await f.finance.approve.run(call('finance-3', 10)));
  assert.equal(final.value.kind, 'approved'); assert.equal(final.value.version, 11);
  assert.equal(value(f.repository.read('e1')).version, 11);
});

test('return and edit enforce authority, state, reason and corrected data', async t => {
  const f = fixture(t); value(await f.employee.submit.run(call('submit')));
  const request = { ...call('return', 2), input: { ...call('return', 2).input, reason: 'fix' } };
  assert.deepEqual(await f.employee.return.run(request), err({ kind: 'SelfApproval' }));
  assert.deepEqual(await f.finance.return.run(request), err({ kind: 'Forbidden' }));
  assert.deepEqual(await f.manager.return.run({ ...request, input: { ...request.input, reason: ' ' } }), err({ kind: 'ReasonRequired' }));
  const edit = { ...call('edit', 2), input: { ...call('edit', 2).input, amount: 5000, receipt: true } };
  assert.deepEqual(await f.employee.edit.run(edit), err({ kind: 'InvalidState' }));
  value(await f.manager.return.run(request));
  const correction = { ...edit, input: { ...edit.input, expectedVersion: 3 } };
  assert.deepEqual(await f.manager.edit.run(correction), err({ kind: 'Forbidden' }));
  assert.deepEqual(await f.employee.edit.run({ ...correction, input: { ...correction.input, amount: 0 } }), err({ kind: 'InvalidExpense' }));
  value(await f.employee.edit.run(correction));
  value(await f.employee.submit.run(call('resubmit', 4)));
  value(await f.manager.reject.run({ ...call('reject', 5), input: { ...call('reject', 5).input, reason: 'terminal' } }));
  assert.deepEqual(await f.employee.edit.run({ ...correction, requestId: 'after-reject', input: { ...correction.input, expectedVersion: 6 } }), err({ kind: 'InvalidState' }));
});

test('competing corrections save once and receipt failure rolls correction back', async t => {
  const f = fixture(t); value(await f.employee.submit.run(call('submit')));
  value(await f.manager.return.run({ ...call('return', 2), input: { ...call('return', 2).input, reason: 'fix' } }));
  const edit = { ...call('edit', 3), input: { ...call('edit', 3).input, amount: 5000, receipt: true } };
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_edit BEFORE INSERT ON expense_receipts WHEN NEW.request_id='edit' BEGIN SELECT RAISE(ABORT,'fail'); END");
  assert.deepEqual(await f.employee.edit.run(edit), err({ kind: 'RepositoryUnavailable' }));
  assert.equal(value(f.repository.read('e1')).kind, 'returned');
  assert.equal(db.prepare('SELECT count(*) AS n FROM expense_changes').get()!.n, 2);
  db.exec('DROP TRIGGER fail_edit'); db.close();
  const other = new ReplaySqliteExpenses(f.path);
  try {
    const results = await Promise.all([f.employee.edit.run(edit), expenseReplayCommands(other, employee).edit.run({ ...edit, requestId: 'different' })]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok), err({ kind: 'SaveConflict' }));
  } finally { other.close(); }
});

test('receipt boundary rejects a correction decision paired with different request content', async t => {
  const f = fixture(t); value(await f.employee.submit.run(call('submit')));
  value(await f.manager.return.run({ ...call('return', 2), input: { ...call('return', 2).input, reason: 'fix' } }));
  const input = { id: 'e1', expectedVersion: 3, amount: 5000, receipt: true };
  const decision = value(edit(value(validateEdit(value(await f.repository.load(input, employee))))));
  assert.deepEqual(await f.repository.saveRequest({ operation: 'edit', actor: employee, requestId: 'mismatch',
    input: { ...input, amount: 2000 } }, decision), err({ kind: 'InvalidRequest' }));
  assert.equal(value(f.repository.read('e1')).kind, 'returned');
});

test('expense detailed replay distinguishes executed workflow from receipt-only response', async t => {
  const f = fixture(t);
  const first = await f.employee.submit.runDetailed(call('submit'));
  assert.equal(value(first.result).kind, 'committed');
  assert.deepEqual(first.attempt?.trace?.map(x => x.step), ['expense.submit.v1:load', 'validate-submission', 'route-submission', 'submit', 'expense.submit.v1']);
  const replay = await f.employee.submit.runDetailed(call('submit'));
  assert.equal(value(replay.result).kind, 'replayed'); assert.equal(replay.attempt, null);
  assert.deepEqual(replay.trace, [{ kind: 'snapshot', status: 'ok' }, { kind: 'lookup', phase: 'before', status: 'found' }]);
  const denied = await f.employee.approve.runDetailed(call('deny', 2));
  assert.deepEqual(denied.result, err({ kind: 'SelfApproval' }));
  assert.deepEqual(denied.attempt?.trace?.map(x => x.step), ['expense.approve.v1:load', 'authorize-approval']);
});
test('expense unknown commit report preserves failing save and successful resolution', async t => {
  const f = fixture(t), save = f.repository.saveRequest.bind(f.repository);
  f.repository.saveRequest = async (request, change) => {
    const result = await save(request, change);
    return result.ok ? err({ kind: 'RepositoryUnavailable' as const }) : result;
  };
  const detail = await f.employee.submit.runDetailed(call('unknown'));
  assert.equal(value(detail.result).kind, 'replayed');
  assert.deepEqual(detail.attempt?.result, err({ kind: 'RepositoryUnavailable' }));
  assert.equal(detail.attempt?.trace?.at(-1)?.status, 'error');
  assert.deepEqual(detail.trace.slice(-2), [{ kind: 'resolution', status: 'lookup' }, { kind: 'lookup', phase: 'after-error', status: 'found' }]);
});

test('submission route failure is visible as a requirement and stops evolution and save', async t => {
  const f = fixture(t, 5000, false);
  const report = await f.employee.submit.runDetailed(call('no-receipt'));
  assert.deepEqual(report.result, err({ kind: 'ReceiptRequired' }));
  assert.deepEqual(report.attempt?.trace, [
    { step: 'expense.submit.v1:load', status: 'ok' },
    { step: 'validate-submission', status: 'ok' },
    { step: 'route-submission', status: 'error' },
  ]);
  assert.equal(value(f.repository.read('e1')).version, 1);
});
