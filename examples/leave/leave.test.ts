import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { err, type Result } from 'koyuki';
import { SqliteLeave } from './repository.js';
import { leaveCommands, leaveApplication, submitted, approved } from './application.js';
import { balance, restoreAccount, validateSubmission, requireDays, submit, type Actor, type Input } from './domain.js';
function value<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
const employee: Actor = { id: 'owner', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };
const call = (requestId: string, expectedVersion = 1, leaveId = 'leave-1') => ({ requestId, input: { employee: 'owner', leaveId, expectedVersion } });
const application = { ...call('submit'), input: { ...call('submit').input, days: 3 } };
function fixture(t: { after(fn: () => void): void }, days = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-')), path = join(dir, 'leave.sqlite');
  const repository = new SqliteLeave(path); value(repository.seed('owner', days));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { repository, path, employee: leaveCommands(repository, employee), manager: leaveCommands(repository, manager) };
}
test('submit reserves, approval consumes; historical replay never consumes twice', async t => {
  const f = fixture(t);
  const pending = value(await f.employee.submit.run(application));
  assert.deepEqual(balance(pending.value), { granted: 5, available: 2, reserved: 3, used: 0 });
  const approved = value(await f.manager.approve.run(call('approve', 2)));
  assert.deepEqual(balance(approved.value), { granted: 5, available: 2, reserved: 0, used: 3 });
  assert.equal(value(await f.manager.approve.run(call('approve', 2))).kind, 'replayed');
  const old = value(await f.employee.submit.run(application)); assert.equal(old.kind, 'replayed');
  assert.equal(old.value.leaves[0]!.kind, 'pending');
  assert.equal(value(f.repository.read('owner')).leaves[0]!.kind, 'approved');
});
test('withdrawal releases reservations; replacement request can use all remaining days', async t => {
  const f = fixture(t); value(await f.employee.submit.run(application));
  const withdrawn = value(await f.employee.withdraw.run(call('withdraw', 2)));
  assert.equal(balance(withdrawn.value).available, 5);
  value(await f.employee.submit.run({ ...call('next', 3, 'leave-2'), input: { ...call('next', 3, 'leave-2').input, days: 5 } }));
  assert.equal(balance(value(f.repository.read('owner'))).available, 0);
  assert.equal(value(await f.employee.withdraw.run(call('withdraw', 2))).kind, 'replayed');
  assert.equal(balance(value(f.repository.read('owner'))).available, 0);
});
test('invalid quantity, insufficient days and duplicate business ID never write', async t => {
  const f = fixture(t);
  for (const days of [0, -1, 0.5, NaN]) assert.deepEqual(await f.employee.submit.run({ ...application, input: { ...application.input, days } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await f.employee.submit.run({ ...application, input: { ...application.input, days: 6 } }), err({ kind: 'InsufficientDays' }));
  assert.equal(value(f.repository.read('owner')).version, 1);
  value(await f.employee.submit.run(application));
  assert.deepEqual(await f.employee.submit.run({ ...call('duplicate', 2), input: { ...call('duplicate', 2).input, days: 1 } }), err({ kind: 'InvalidState' }));
});
test('trusted identity, role, active status and pending state restrict operations', async t => {
  const f = fixture(t);
  assert.deepEqual(await leaveCommands(f.repository, { ...employee, id: 'other' }).submit.run(application), err({ kind: 'Forbidden' }));
  assert.deepEqual(await leaveCommands(f.repository, { ...employee, active: false }).submit.run(application), err({ kind: 'Forbidden' }));
  value(await f.employee.submit.run(application));
  assert.deepEqual(await f.employee.approve.run(call('approve', 2)), err({ kind: 'Forbidden' }));
  const forged = { ...call('forged', 2), actor: manager, operation: 'approve' };
  assert.deepEqual(await f.employee.approve.run(forged), err({ kind: 'Forbidden' }));
  assert.deepEqual(await leaveCommands(f.repository, { ...manager, id: 'owner' }).approve.run(call('approve', 2)), err({ kind: 'Forbidden' }));
  assert.deepEqual(await f.manager.withdraw.run(call('withdraw', 2)), err({ kind: 'Forbidden' }));
  value(await f.manager.approve.run(call('approve', 2)));
  assert.deepEqual(await f.employee.withdraw.run(call('withdraw-after-approval', 3)), err({ kind: 'InvalidState' }));
});
test('key reuse binds content, actor and operation', async t => {
  const f = fixture(t); value(await f.employee.submit.run(application));
  assert.deepEqual(await f.employee.submit.run({ ...application, input: { ...application.input, days: 4 } }), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(await f.manager.approve.run(call('submit')), err({ kind: 'IdempotencyConflict' }));
  assert.deepEqual(await leaveCommands(f.repository, { ...employee, active: false }).submit.run(application), err({ kind: 'IdempotencyConflict' }));
});
// Force independent connections to load the same revision before either can save.
async function snapshotRace(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t), other = new SqliteLeave(f.path);
  t.after(() => other.close());
  let release!: () => void, waiting = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const repository of [f.repository, other]) {
    const load = repository.load.bind(repository);
    repository.load = async <I extends Input>(input: I, actor: Actor) => {
      const loaded = await load(input, actor);
      if (++waiting === 2) release(); await gate; return loaded;
    };
  }
  return { ...f, otherRepository: other, other: leaveCommands(other, employee) };
}
test('concurrent submissions cannot reserve more than the balance', async t => {
  const f = await snapshotRace(t);
  const results = await Promise.all([f.employee.submit.run(application), f.other.submit.run({ ...call('second', 1, 'leave-2'), input: { ...call('second', 1, 'leave-2').input, days: 3 } })]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(results.find(r => !r.ok), err({ kind: 'Conflict' }));
  const account = value(f.repository.read('owner')); assert.equal(account.leaves.length, 1); assert.equal(balance(account).available, 2);
});
test('identical simultaneous requests resolve one commit and one replay', async t => {
  const f = await snapshotRace(t);
  const results = await Promise.all([f.employee.submit.run(application), f.other.submit.run(application)]);
  assert.deepEqual(results.map(r => value(r).kind).sort(), ['committed', 'replayed']);
  assert.equal(value(f.repository.read('owner')).version, 2);
});
test('receipt insert failure rolls account and history back', async t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'fail'); END");
  assert.deepEqual(await f.employee.submit.run(application), err({ kind: 'StorageUnavailable' }));
  assert.equal(value(f.repository.read('owner')).version, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM changes').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM receipts').get()!.n, 0); db.close();
});
test('old replay output does not rewind current Application view', async t => {
  const f = fixture(t); value(await f.employee.submit.run(application)); value(await f.manager.approve.run(call('approve', 2)));
  const session = await leaveApplication(f.repository, employee, value(f.repository.read('owner'))).start();
  await session.dispatch({ type: 'submit', input: application });
  assert.equal(session.snapshot().view.account.leaves[0]!.kind, 'approved');
  assert.equal(session.snapshot().view.balance.used, 3);
});
test('successful receipts persist across fresh process startup', async t => {
  const f = fixture(t); value(await f.employee.submit.run(application));
  const code = `import { SqliteLeave } from './repository.ts'; import { leaveCommands } from './application.ts'; const r=new SqliteLeave(process.argv[1]); try { console.log(JSON.stringify(await leaveCommands(r,${JSON.stringify(employee)}).submit.run(${JSON.stringify(application)}))); } finally {r.close();}`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, f.path], { cwd: import.meta.dirname, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).value.kind, 'replayed');
});
test('corrupt accounting and receipt data are rejected instead of trusted', async t => {
  assert.deepEqual(restoreAccount({ employee: 'owner', granted: 2, version: 2, leaves: [{ id: 'x', days: 3, kind: 'pending' }] }), err({ kind: 'CorruptLeave' }));
  assert.deepEqual(restoreAccount({ employee: 'owner', granted: 5, version: 1, leaves: [{ id: 'x', days: 3, kind: 'pending' }] }), err({ kind: 'CorruptLeave' }));
  const f = fixture(t); value(await f.employee.submit.run(application));
  const db = new DatabaseSync(f.path); db.prepare('UPDATE receipts SET result_json=?').run('{}'); db.close();
  assert.deepEqual(await f.employee.submit.run(application), err({ kind: 'CorruptLeave' }));
});
test('pure transition preserves inputs; invalid stage connections are rejected by types', async () => {
  const account = value(restoreAccount({ employee: 'owner', granted: 5, version: 1, leaves: [] }));
  const loaded = { account, actor: employee, input: application.input };
  const before = structuredClone(loaded);
  const change = value(submit(value(requireDays(value(validateSubmission(loaded))))));
  assert.deepEqual(loaded, before); assert.equal(change.next.leaves[0]!.kind, 'pending');
  if (false) {
    // @ts-expect-error balance check cannot be skipped
    submit(value(validateSubmission(loaded)));
    // @ts-expect-error submit requires days in its input
    leaveCommands({} as SqliteLeave, employee).submit.run(call('bad'));
    // @ts-expect-error submit output cannot feed an approval evolution directly
    const invalid: typeof submitted = { ...submitted, evolve: approved.evolve };
  }
});

test('approval racing withdrawal resolves one terminal result without leaking reservations', async t => {
  const f = fixture(t); value(await f.employee.submit.run(application));
  const other = new SqliteLeave(f.path); t.after(() => other.close());
  let release!: () => void, waiting = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const repository of [f.repository, other]) {
    const load = repository.load.bind(repository);
    repository.load = async <I extends Input>(input: I, actor: Actor) => {
      const result = await load(input, actor); if (++waiting === 2) release(); await gate; return result;
    };
  }
  const results = await Promise.all([f.manager.approve.run(call('approve', 2)), leaveCommands(other, employee).withdraw.run(call('withdraw', 2))]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(results.find(r => !r.ok), err({ kind: 'Conflict' }));
  const a = value(f.repository.read('owner')); assert.equal(a.version, 3); assert.equal(balance(a).reserved, 0);
  assert.equal(balance(a).available, a.leaves[0]!.kind === 'approved' ? 2 : 5);
});
test('lost commit response is resolved through receipt without repeating the write', async t => {
  const f = fixture(t); let saves = 0;
  const command = leaveCommands({
    load: f.repository.load.bind(f.repository), receipt: f.repository.receipt.bind(f.repository),
    save: async (request, change) => { saves++; const result = await f.repository.save(request, change); return result.ok ? err({ kind: 'StorageUnavailable' as const }) : result; },
  }, employee);
  assert.equal(value(await command.submit.run(application)).kind, 'replayed');
  assert.equal(saves, 1); assert.equal(value(f.repository.read('owner')).version, 2);
});
