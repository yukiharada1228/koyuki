import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { transition } from './framework/index.js';
import { draftExpense, restoreExpense, type Actor } from './expenses/domain.js';
import { MemoryExpenses } from './expenses/repository.js';
import { SqliteExpenses } from './expenses/sqlite.js';
import { expenseApplication, expenseModel, submitted, approved, rejected } from './expenses/application.js';
const employee: Actor = { id: 'owner', role: 'employee', active: true }, manager: Actor = { id: 'boss', role: 'manager', active: true }, finance: Actor = { id: 'finance', role: 'finance', active: true };
function fixture(t: { after(fn: () => void): void }, amount = 200000) {
  const directory = mkdtempSync(join(tmpdir(), 'expense-sqlite-')), path = join(directory, 'expenses.sqlite');
  const repository = new SqliteExpenses(path);
  const draft = draftExpense({ id: 'e1', owner: 'owner', amount, receipt: true }); assert(draft.ok); assert(repository.insertDraft(draft.value).ok);
  t.after(() => { try { repository.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { repository, path, draft: draft.value };
}
async function submit(repository: SqliteExpenses) {
  const result = await expenseModel(repository, employee).change.on(submitted).run({ id: 'e1', expectedVersion: 1 }); assert(result.ok); return result.value;
}
test('SQLite adapter completes submit/manager/finance without changing application declarations', async t => {
  const f = fixture(t);
  for (const [actor, type, version, kind] of [[employee, 'submit', 1, 'manager'], [manager, 'approve', 2, 'finance'], [finance, 'approve', 3, 'approved']] as const) {
    const rows = f.repository.list(); assert(rows.ok);
    const session = await expenseApplication(f.repository, actor, rows.value).start();
    assert((await session.dispatch({ type, input: { id: 'e1', expectedVersion: version } })).ok);
    assert.equal(session.snapshot().view.expenses[0]?.kind, kind);
  }
  const row = f.repository.read('e1'); assert(row.ok && row.value.kind === 'approved');
  assert.deepEqual(row.value.approval, { kind: 'finance', manager: 'boss', finance: 'finance' });
});
test('manager approval survives process shutdown; a fresh process performs finance approval', async t => {
  const f = fixture(t); await submit(f.repository);
  assert((await expenseModel(f.repository, manager).change.on(approved).run({ id: 'e1', expectedVersion: 2 })).ok);
  f.repository.close();
  const sqlite = pathToFileURL(resolve('src/expenses/sqlite.ts')).href, app = pathToFileURL(resolve('src/expenses/application.ts')).href;
  const script = `import {SqliteExpenses} from ${JSON.stringify(sqlite)}; import {expenseApplication} from ${JSON.stringify(app)};
    const repo=new SqliteExpenses(process.argv[1]); const rows=repo.list(); if(!rows.ok)throw Error('Load');
    const session=await expenseApplication(repo,{id:'finance',role:'finance',active:true},rows.value).start();
    await session.dispatch({type:'approve',input:{id:'e1',expectedVersion:3}});
    console.log(JSON.stringify(session.snapshot().state)); repo.close();`;
  const state = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.path], { encoding: 'utf8' }));
  assert.equal(state.data[0].kind, 'approved'); assert.equal(state.data[0].version, 4);
  const reopened = new SqliteExpenses(f.path); try { const result = reopened.read('e1'); assert(result.ok && result.value.kind === 'approved'); } finally { reopened.close(); }
});
test('two connections cannot both save prepared approve and reject decisions', async t => {
  const f = fixture(t); await submit(f.repository); const other = new SqliteExpenses(f.path);
  try {
    const yes = await f.repository.load({ id: 'e1', expectedVersion: 2 }, manager), no = await other.loadReject({ id: 'e1', expectedVersion: 2, reason: 'policy' }, manager); assert(yes.ok && no.ok);
    const a = transition(approved).run(yes.value), b = transition(rejected).run(no.value); assert(a.ok && b.ok);
    const outcomes = await Promise.all([f.repository.save(a.value), other.save(b.value)]);
    assert.equal(outcomes.filter(r => r.ok).length, 1); assert(outcomes.some(r => !r.ok && r.error.kind === 'SaveConflict'));
  } finally { other.close(); }
});
test('two real processes prepare the same version before racing their writes', async t => {
  const f = fixture(t); await submit(f.repository);
  const sqlite = pathToFileURL(resolve('src/expenses/sqlite.ts')).href, app = pathToFileURL(resolve('src/expenses/application.ts')).href, kernel = pathToFileURL(resolve('src/framework/index.ts')).href;
  const script = `import{SqliteExpenses}from ${JSON.stringify(sqlite)};import{approved,rejected}from ${JSON.stringify(app)};import{transition}from ${JSON.stringify(kernel)};
    const repo=new SqliteExpenses(process.argv[1]), mode=process.argv[2], actor={id:'boss',role:'manager',active:true};
    const loaded=mode==='yes'?await repo.load({id:'e1',expectedVersion:2},actor):await repo.loadReject({id:'e1',expectedVersion:2,reason:'policy'},actor);
    if(!loaded.ok)throw Error('load'); const prepared=transition(mode==='yes'?approved:rejected).run(loaded.value);if(!prepared.ok)throw Error('prepare');
    console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve));
    console.log(JSON.stringify(await repo.save(prepared.value)));repo.close();process.stdin.destroy();`;
  function child(mode: string) {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.path, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; process.stderr.on('data', chunk => { errors += chunk; });
    const ready = new Promise<void>((resolve, reject) => { process.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) resolve(); }); process.on('error', reject); process.on('exit', code => { if (!output.includes('ready\n')) reject(new Error(errors || `Exit ${code}`)); }); });
    const done = new Promise<unknown>((resolve, reject) => { process.on('error', reject); process.on('exit', code => { if (code !== 0) reject(new Error(errors)); else resolve(JSON.parse(output.trim().split('\n').at(-1)!)); }); });
    t.after(() => { if (process.exitCode === null) process.kill(); });
    return { process, ready, done };
  }
  const a = child('yes'), b = child('no'); await Promise.all([a.ready, b.ready]);
  a.process.stdin.end('go'); b.process.stdin.end('go');
  const results = await Promise.all([a.done, b.done]) as { ok: boolean; error?: { kind: string } }[];
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok)?.error?.kind, 'SaveConflict');
});
test('state write rolls back if recording transition history fails', async t => {
  const f = fixture(t); await submit(f.repository); const db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON expense_changes BEGIN SELECT RAISE(ABORT,'injected'); END");
    const result = await expenseModel(f.repository, manager).change.on(approved).run({ id: 'e1', expectedVersion: 2 });
    assert(!result.ok && result.error.kind === 'RepositoryUnavailable');
    const stored = f.repository.read('e1'); assert(stored.ok); assert.equal(stored.value.kind, 'manager'); assert.equal(stored.value.version, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM expense_changes').get()?.n, 1);
  } finally { db.close(); }
});
test('restore rejects unknown states, missing evidence and invalid state/amount/version combinations', () => {
  const base = { id: 'e1', owner: 'owner', amount: 200000, receipt: true, version: 3, kind: 'finance', manager: 'boss' };
  for (const raw of [null, {}, { ...base, kind: 'unknown' }, { ...base, manager: null }, { ...base, manager: 'owner' }, { ...base, receipt: false }, { ...base, amount: 100 }, { ...base, version: 2 }, { ...base, kind: 'approved', approval: { kind: 'finance', manager: 'boss' } }, { ...base, kind: 'rejected', by: 'boss', reason: '' }]) assert.deepEqual(restoreExpense(raw), { ok: false, error: { kind: 'CorruptExpense' } });
});
for (const bad of ['invalid-json', 'missing-manager', 'version-mismatch', 'id-mismatch']) {
  test(`corrupt SQLite row ${bad} fails both read and application load`, async t => {
    const f = fixture(t); await submit(f.repository); const db = new DatabaseSync(f.path);
    try {
      let state: unknown = { ...f.draft, kind: 'finance', version: 3 };
      if (bad === 'version-mismatch') state = { ...f.draft, version: 1 };
      if (bad === 'id-mismatch') state = { ...f.draft, id: 'other', version: 2, kind: 'manager' };
      db.prepare('UPDATE expenses SET state_json=? WHERE id=?').run(bad === 'invalid-json' ? '{' : JSON.stringify(state), 'e1');
      assert.deepEqual(f.repository.read('e1'), { ok: false, error: { kind: 'CorruptExpense' } });
      const result = await expenseModel(f.repository, manager).change.on(approved).run({ id: 'e1', expectedVersion: 2 });
      assert(!result.ok && result.error.kind === 'CorruptExpense');
    } finally { db.close(); }
  });
}
test('SQLite and memory adapters preserve business outcomes across amount branches', async t => {
  for (const amount of [100, 5000, 200000]) {
    const f = fixture(t, amount), memory = new MemoryExpenses([f.draft]);
    for (const [actor, event, version] of [[employee, submitted, 1], [manager, approved, 2], [finance, approved, 3]] as const) {
      const a = expenseModel(f.repository, actor).change, b = expenseModel(memory, actor).change;
      const left = await (version === 1 ? a.on(submitted) : a.on(approved)).run({ id: 'e1', expectedVersion: version });
      const right = await (version === 1 ? b.on(submitted) : b.on(approved)).run({ id: 'e1', expectedVersion: version });
      assert.deepEqual(left, right); const listed = f.repository.list(); assert(listed.ok); assert.deepEqual(listed.value, memory.list());
    }
  }
});
test('rejection at either approval stage survives reopening', async t => {
  for (const stage of ['manager', 'finance']) {
    const f = fixture(t); await submit(f.repository);
    if (stage === 'finance') assert((await expenseModel(f.repository, manager).change.on(approved).run({ id: 'e1', expectedVersion: 2 })).ok);
    const result = await expenseModel(f.repository, stage === 'manager' ? manager : finance).rejection.on(rejected).run({ id: 'e1', expectedVersion: stage === 'manager' ? 2 : 3, reason: 'policy' }); assert(result.ok);
    f.repository.close(); const reopened = new SqliteExpenses(f.path);
    try { const row = reopened.read('e1'); assert(row.ok && row.value.kind === 'rejected'); assert.equal(row.value.reason, 'policy'); } finally { reopened.close(); }
  }
});
test('closed database becomes a typed storage failure; duplicate draft does not overwrite', async t => {
  const f = fixture(t); assert.deepEqual(f.repository.insertDraft(f.draft), { ok: false, error: { kind: 'SaveConflict' } });
  f.repository.close(); assert.deepEqual(await f.repository.load({ id: 'e1', expectedVersion: 1 }, employee), { ok: false, error: { kind: 'RepositoryUnavailable' } });
});
