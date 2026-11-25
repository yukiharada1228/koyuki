import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { auditRecord, transition, type AuditRecord, type AuditIdentity } from './framework/index.js';
import { SqliteTagRepository } from './tags/sqlite.js';
import { createTagFeature } from './tags/feature.js';
import { SqliteExpenses } from './expenses/sqlite.js';
import { ReplaySqliteExpenses, type ExpenseRequest } from './expenses/sqlite-replay.js';
import { draftExpense, type Actor } from './expenses/domain.js';
import { submitted } from './expenses/application.js';
const employee: Actor = { id: 'owner', role: 'employee', active: true };
const metadata = (operationId = 'request-1'): AuditIdentity => ({ actorId: 'owner', operationId, definitionVersion: '2026-11-25', occurredAt: '2026-11-25T00:00:00.000Z' });
function location(t: { after(work: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-audit-')), path = join(dir, 'database.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true })); return path;
}
function records(db: DatabaseSync): AuditRecord[] { return db.prepare('SELECT record_json FROM koyuki_audit ORDER BY after_version').all().map(row => JSON.parse(String(row.record_json))); }
function seed(repository: SqliteExpenses) {
  const draft = draftExpense({ id: 'e1', owner: 'owner', amount: 200000, receipt: true });
  assert(draft.ok); assert(repository.insertDraft(draft.value).ok);
}
test('tags use the common format, ignore payload identity and do not repeat success audit on receipt replay', async t => {
  const path = location(t); let identities = 0;
  const repository = new SqliteTagRepository(path, { audit: { identity: () => metadata(`request-${++identities}`) } });
  const db = new DatabaseSync(path);
  try {
    const feature = createTagFeature(repository);
    const input = { groupId: 'g', label: 'secret label', icon: null, actorId: 'forged' };
    const loaded = await repository.loadCreate(input); assert(loaded.ok);
    const first = await feature.create.run(loaded.value); assert(first.ok);
    assert.deepEqual(await feature.create.run(loaded.value), first);
    assert.equal(records(db).length, 1); assert.equal(identities, 1);
    assert((await feature.updateAction({ groupId: 'g', id: first.value.data.id, label: 'private label', icon: null, expectedVersion: 1 })).ok);
    const [created, updated] = records(db); assert(created && updated);
    assert.deepEqual(created, auditRecord(metadata('request-1'), 'tag.create.v1', { targetType: 'tag', targetId: first.value.data.id, beforeVersion: null, afterVersion: 1 }));
    assert.deepEqual(updated, auditRecord(metadata('request-2'), 'tag.update.v1', { targetType: 'tag', targetId: first.value.data.id, beforeVersion: 1, afterVersion: 2 }));
    assert(!JSON.stringify(records(db)).includes('label'));
  } finally { db.close(); repository.close(); }
});
test('audit insertion failure rolls back tag, group version and receipt together', async t => {
  const path = location(t), repository = new SqliteTagRepository(path, { audit: { identity: () => metadata() } }), db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON koyuki_audit BEGIN SELECT RAISE(ABORT,'audit failed'); END");
    const loaded = await repository.loadCreate({ groupId: 'g', label: 'VIP', icon: null }); assert(loaded.ok);
    const feature = createTagFeature(repository), failed = await feature.create.run(loaded.value);
    assert(!failed.ok && failed.error.kind === 'RepositoryUnavailable');
    for (const table of ['tags', 'mutation_receipts', 'koyuki_audit']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, 0);
    assert.equal(db.prepare("SELECT version FROM groups WHERE id='g'").get()?.version, 0);
    db.exec('DROP TRIGGER fail_audit'); assert((await feature.create.run(loaded.value)).ok); assert.equal(records(db).length, 1);
  } finally { db.close(); repository.close(); }
});
for (const failure of ['audit', 'receipt', 'history'] as const) {
  test(`expense ${failure} failure leaves state, history, receipt and audit unchanged; explicit retry and replay are safe`, async t => {
    const path = location(t), repository = new ReplaySqliteExpenses(path, { audit: { identity: operation => metadata(operation) } }), db = new DatabaseSync(path);
    try {
      seed(repository);
      const request: ExpenseRequest = { operation: 'submit', actor: employee, requestId: 'receipt-1', input: { id: 'e1', expectedVersion: 1 } };
      const loaded = await repository.load(request.input, employee); assert(loaded.ok);
      const prepared = transition(submitted).run(loaded.value); assert(prepared.ok);
      const table = failure === 'audit' ? 'koyuki_audit' : failure === 'receipt' ? 'expense_receipts' : 'expense_changes';
      db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
      const failed = await repository.saveRequest(request, prepared.value); assert(!failed.ok && failed.error.kind === 'RepositoryUnavailable');
      const state = repository.read('e1'); assert(state.ok); assert.equal(state.value.version, 1);
      for (const name of ['expense_changes', 'expense_receipts']) assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get()?.n, 0);
      assert.equal(records(db).length, 1);
      db.exec('DROP TRIGGER fail_write');
      const saved = await repository.saveRequest(request, prepared.value); assert(saved.ok && saved.value.kind === 'committed');
      const replay = await repository.saveRequest(request, prepared.value); assert(replay.ok && replay.value.kind === 'replayed');
      assert.deepEqual(records(db), [
        auditRecord(metadata('expense.create.v1'), 'expense.create.v1', { targetType: 'expense', targetId: 'e1', beforeVersion: null, afterVersion: 1 }),
        auditRecord(metadata('expense.submit.v1'), 'expense.submit.v1', { targetType: 'expense', targetId: 'e1', beforeVersion: 1, afterVersion: 2 }),
      ]);
      assert.equal(db.prepare('SELECT count(*) n FROM expense_changes').get()?.n, 1);
      assert.equal(db.prepare('SELECT count(*) n FROM expense_receipts').get()?.n, 1);
    } finally { db.close(); repository.close(); }
  });
}
test('two independent tag connections commit only one audit for the winning stale-snapshot writer', async t => {
  const path = location(t), first = new SqliteTagRepository(path, { audit: { identity: () => metadata('first') } }), second = new SqliteTagRepository(path, { audit: { identity: () => metadata('second') } }), db = new DatabaseSync(path);
  try {
    const a = await first.loadCreate({ groupId: 'g', label: 'A', icon: null }), b = await second.loadCreate({ groupId: 'g', label: 'B', icon: null }); assert(a.ok && b.ok);
    const results = await Promise.all([createTagFeature(first).create.run(a.value), createTagFeature(second).create.run(b.value)]);
    assert.equal(results.filter(result => result.ok).length, 1); assert.equal(records(db).length, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM tags').get()?.n, 1);
  } finally { db.close(); second.close(); first.close(); }
});
test('invalid host audit metadata fails closed without persisting state', async t => {
  const path = location(t), repository = new SqliteExpenses(path, { audit: { identity: () => ({ ...metadata(), actorId: '' }) } }), db = new DatabaseSync(path);
  try {
    const draft = draftExpense({ id: 'e1', owner: 'owner', amount: 200000, receipt: true }); assert(draft.ok);
    const result = repository.insertDraft(draft.value); assert(!result.ok && result.error.kind === 'RepositoryUnavailable');
    assert.equal(db.prepare('SELECT count(*) n FROM expenses').get()?.n, 0);
    assert.equal(records(db).length, 0); assert.equal(db.prepare('SELECT count(*) n FROM expense_changes').get()?.n, 0);
  } finally { db.close(); repository.close(); }
});

test('a peer opened before audit activation and an unconfigured reopened writer cannot bypass audit', async t => {
  const path = location(t), peer = new SqliteTagRepository(path);
  const audited = new SqliteTagRepository(path, { audit: { identity: () => metadata() } }), reopened = new SqliteTagRepository(path), db = new DatabaseSync(path);
  try {
    for (const repository of [peer, reopened]) {
      const loaded = await repository.loadCreate({ groupId: 'g', label: 'attempt', icon: null }); assert(loaded.ok);
      const result = await createTagFeature(repository).create.run(loaded.value); assert(!result.ok && result.error.kind === 'RepositoryUnavailable');
    }
    assert.equal(db.prepare('SELECT count(*) n FROM tags').get()?.n, 0); assert.equal(records(db).length, 0);
    const created = await createTagFeature(audited).createAction({ groupId: 'g', label: 'audited', icon: null }); assert(created.ok);
    const readable = peer.list('g'); assert(readable.ok && readable.value.length === 1);
    assert.equal(records(db).length, 1);
  } finally { db.close(); reopened.close(); audited.close(); peer.close(); }
});
test('tag archive and restore use the same audit boundary and do not repeat replay audit', async t => {
  const { createLifecycleFeature, archiveWorkflow } = await import('./tags/lifecycle.js');
  const path = location(t); let next = 0;
  const repository = new SqliteTagRepository(path, { audit: { identity: () => metadata(`request-${++next}`) } }), db = new DatabaseSync(path);
  try {
    const created = await createTagFeature(repository).createAction({ groupId: 'g', label: 'VIP', icon: null }); assert(created.ok);
    const lifecycle = createLifecycleFeature(repository), archive = { id: created.value.data.id, expectedVersion: 1 };
    const loaded = await repository.loadLifecycle(archive); assert(loaded.ok);
    const prepared = archiveWorkflow.run(loaded.value); assert(prepared.ok);
    assert((await repository.saveLifecycle(prepared.value)).ok);
    assert((await repository.saveLifecycle(prepared.value)).ok);
    assert.equal(records(db).length, 2);
    assert((await lifecycle.restore.run({ id: created.value.data.id, expectedVersion: 2 })).ok);
    assert.deepEqual(records(db).map(record => [record.operation, record.beforeVersion, record.afterVersion]), [['tag.create.v1', null, 1], ['tag.archive.v1', 1, 2], ['tag.restore.v1', 2, 3]]);
  } finally { db.close(); repository.close(); }
});

for (const route of ['approval', 'rejection', 'correction'] as const) {
  test(`expense ${route} records every committed version and trusted actor, excluding denied operations`, async t => {
    const { expenseModel, approved, rejected, returned, edited } = await import('./expenses/application.js');
    const path = location(t), boss: Actor = { id: 'boss', role: 'manager', active: true }, finance: Actor = { id: 'finance', role: 'finance', active: true };
    let actor = employee, next = 0;
    const repository = new SqliteExpenses(path, { audit: { identity: () => ({ ...metadata(`request-${++next}`), actorId: actor.id }) } }), db = new DatabaseSync(path);
    try {
      seed(repository);
      const ownerModel = expenseModel(repository, employee), bossModel = expenseModel(repository, boss);
      assert((await ownerModel.change.on(submitted).run({ id: 'e1', expectedVersion: 1 })).ok);
      const denied = await ownerModel.change.on(approved).run({ id: 'e1', expectedVersion: 2 }); assert(!denied.ok);
      assert.equal(records(db).length, 2);
      actor = boss;
      const expected = [['expense.create.v1', 'owner'], ['expense.submit.v1', 'owner']];
      if (route === 'approval') {
        assert((await bossModel.change.on(approved).run({ id: 'e1', expectedVersion: 2 })).ok); actor = finance;
        assert((await expenseModel(repository, finance).change.on(approved).run({ id: 'e1', expectedVersion: 3 })).ok);
        expected.push(['expense.approve.v1', 'boss'], ['expense.approve.v1', 'finance']);
      } else if (route === 'rejection') {
        assert((await bossModel.rejection.on(rejected).run({ id: 'e1', expectedVersion: 2, reason: 'private explanation' })).ok);
        expected.push(['expense.reject.v1', 'boss']);
      } else {
        assert((await bossModel.rejection.on(returned).run({ id: 'e1', expectedVersion: 2, reason: 'private explanation' })).ok); actor = employee;
        assert((await ownerModel.correction.on(edited).run({ id: 'e1', expectedVersion: 3, amount: 210000, receipt: true })).ok);
        expected.push(['expense.return.v1', 'boss'], ['expense.edit.v1', 'owner']);
      }
      const audit = records(db);
      assert.deepEqual(audit.map(row => [row.operation, row.actorId]), expected);
      assert.deepEqual(audit.map(row => row.afterVersion), expected.map((_, index) => index + 1));
      assert(!JSON.stringify(audit).includes('private'));
    } finally { db.close(); repository.close(); }
  });
}

test('two OS processes replay the same expense request with one state change and one success audit', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const path = location(t), parent = new ReplaySqliteExpenses(path, { audit: { identity: () => metadata('create') } });
  seed(parent); parent.close();
  const source = `import {ReplaySqliteExpenses} from ${JSON.stringify(pathToFileURL(resolve('src/expenses/sqlite-replay.ts')).href)};
    import {transition} from ${JSON.stringify(pathToFileURL(resolve('src/framework/index.ts')).href)};
    import {submitted} from ${JSON.stringify(pathToFileURL(resolve('src/expenses/application.ts')).href)};
    const actor=${JSON.stringify(employee)}, identity=${JSON.stringify(metadata('submit'))};
    const repo=new ReplaySqliteExpenses(process.argv[1], {audit:{identity:()=>identity}});
    const input={id:'e1',expectedVersion:1}, loaded=await repo.load(input,actor);
    if(!loaded.ok)throw Error('load'); const prepared=transition(submitted).run(loaded.value);if(!prepared.ok)throw Error('prepare');
    console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve));
    console.log(JSON.stringify(await repo.saveRequest({operation:'submit',actor,requestId:'same-request',input},prepared.value)));
    repo.close();process.stdin.destroy();`;
  function worker() {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) resolve(); });
      child.on('error', reject); child.on('exit', code => { if (!output.includes('ready\n')) reject(Error(errors || `Child exit ${code}`)); });
    });
    const done = new Promise<{ ok: boolean; value?: { kind: string } }>((resolve, reject) => {
      child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(Error(errors)); else { try { resolve(JSON.parse(output.trim().split('\n').at(-1)!)); } catch (error) { reject(error); } } });
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, ready, done };
  }
  const first = worker(), second = worker();
  await Promise.all([first.ready, second.ready]); first.child.stdin.end('go'); second.child.stdin.end('go');
  const results = await Promise.all([first.done, second.done]);
  assert(results.every(result => result.ok)); assert.deepEqual(results.map(result => result.value?.kind).sort(), ['committed', 'replayed']);
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('SELECT version FROM expenses WHERE id=?').get('e1')?.version, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM expense_changes').get()?.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM expense_receipts').get()?.n, 1);
    assert.equal(records(db).length, 2); assert.equal(records(db).filter(record => record.operation === 'expense.submit.v1').length, 1);
  } finally { db.close(); }
});
