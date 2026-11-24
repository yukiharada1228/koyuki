import { ht } from './framework/experimental-jsx.js';
/** @jsx ht */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTagRepository } from './tags/sqlite.js';
import { createTagFeature } from './tags/feature.js';
import { createApp } from './web/app.js';
import { createTagAction } from './examples/create-tag.js';
import { createLifecycleFeature, requireActive, archiveTag, requireArchived, checkRestoreCapacity, restoreArchivedTag, type LifecycleCommand, type RestoreChange } from './tags/lifecycle.js';
import { ok, err, workflow, bindMutation, defineAction, type Result } from './framework/index.js';
const input = (label: string) => ({ groupId: 'g', label, icon: null });
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'business-react-lifecycle-')), path = join(dir, 'tags.sqlite');
  const repository = new SqliteTagRepository(path), lifecycle = createLifecycleFeature(repository), feature = createTagFeature(repository);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  async function create(label: string) { const result = await feature.createAction(input(label)); assert(result.ok); return result.value; }
  return { path, repository, lifecycle, feature, create };
}
test('public action entry calls load, decision and save once, with one combined trace', async () => {
  const calls: string[] = [];
  const mutation = bindMutation({ workflow: workflow('decide', (n: number) => { calls.push('decide'); return ok(n + 1); }), operation: 'save', save: async (n: number) => { calls.push('save'); return ok(n); } });
  const action = defineAction({ loadName: 'load', load: async (n: number) => { calls.push('load'); return ok(n); }, mutation });
  const detail = await action.runDetailed(1); assert.deepEqual(detail.result, ok(2));
  assert.deepEqual(calls, ['load', 'decide', 'save']);
  assert.deepEqual(detail.trace.map(t => t.step), ['load', 'decide', 'save']);
});
test('public action load failure stops before pure decision and save', async () => {
  let ran = false;
  const mutation = bindMutation({ workflow: workflow('decide', (n: number) => { ran = true; return ok(n); }), operation: 'save', save: async (n: number) => ok(n) });
  const action = defineAction({ loadName: 'load', load: async (_: string): Promise<Result<number, 'Missing'>> => err('Missing'), mutation });
  const result = await action.runDetailed('x'); assert.deepEqual(result.result, err('Missing')); assert.equal(ran, false);
  assert.deepEqual(result.trace, [{ step: 'load', status: 'error' }]); assert.equal(result.plan, null);
});
test('compiled minimal consumer example runs without private framework imports', async t => {
  const f = fixture(t), result = await createTagAction(f.repository).run(input('Consumer'));
  assert(result.ok && result.value.data.label === 'Consumer');
});
test('archive and restore persist explicit state changes and increment versions', async t => {
  const f = fixture(t), tag = await f.create('A');
  const archived = await f.lifecycle.archive.runDetailed({ id: tag.data.id, expectedVersion: 1 });
  assert(archived.result.ok && archived.result.value.kind === 'archived');
  assert.deepEqual(archived.trace.map(t => t.step), ['load-tag', 'require-active', 'archive-tag', 'tag.archive.v1']);
  assert.equal(archived.result.value.tag.data.version, 2);
  const active = f.repository.list('g'), history = f.repository.list('g', true);
  assert(active.ok && active.value.length === 0); assert(history.ok && history.value.length === 1);
  const restored = await f.lifecycle.restore.run({ id: tag.data.id, expectedVersion: 2 });
  assert(restored.ok && restored.value.kind === 'active' && restored.value.tag.data.version === 3);
});
test('archiving frees capacity; restoring checks active-tag quota', async t => {
  const f = fixture(t), a = await f.create('A'); await f.create('B'); await f.create('C');
  assert((await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 })).ok);
  await f.create('D');
  const full = await f.lifecycle.restore.runDetailed({ id: a.data.id, expectedVersion: 2 });
  assert(!full.result.ok && full.result.error.kind === 'TagLimitReached');
  assert.deepEqual(full.trace.at(-1), { step: 'check-restore-capacity', status: 'error' });
  assert.equal(full.plan, null);
});
test('archived names stay reserved, and archived tags cannot be edited', async t => {
  const f = fixture(t), a = await f.create('A'); await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 });
  const duplicate = await f.feature.createAction(input('A')); assert(!duplicate.ok && duplicate.error.kind === 'DuplicateLabel');
  const edit = await f.feature.updateAction({ ...input('Changed'), id: a.data.id, expectedVersion: 2 }); assert(!edit.ok && edit.error.kind === 'TagArchived');
});
test('wrong lifecycle states are business failures rather than silent success', async t => {
  const f = fixture(t), a = await f.create('A');
  const activeRestore = await f.lifecycle.restore.run({ id: a.data.id, expectedVersion: 1 }); assert(!activeRestore.ok && activeRestore.error.kind === 'NotArchived');
  await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 });
  const repeated = await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 2 }); assert(!repeated.ok && repeated.error.kind === 'AlreadyArchived');
});
test('stale lifecycle request cannot archive a newer edit', async t => {
  const f = fixture(t), a = await f.create('A'); await f.feature.updateAction({ ...input('New'), id: a.data.id, expectedVersion: 1 });
  const stale = await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 }); assert(!stale.ok && stale.error.kind === 'SaveConflict');
});
test('pure archive/restore decisions work without IO and preserve their inputs', async t => {
  const f = fixture(t), a = await f.create('A');
  const command = await f.repository.loadLifecycle({ id: a.data.id, expectedVersion: 1 }); assert(command.ok);
  const before = structuredClone(command.value), decision = f.lifecycle.archiveMutation.prepare(command.value);
  assert(decision.result.ok); assert.deepEqual(command.value, before);
  const active = f.repository.list('g'); assert(active.ok && active.value.length === 1);
});
test('save boundary rechecks restore capacity after another request consumes the slot', async t => {
  const f = fixture(t), a = await f.create('A'); await f.create('B'); await f.create('C');
  await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 });
  const loaded = await f.repository.loadLifecycle({ id: a.data.id, expectedVersion: 2 }); assert(loaded.ok);
  const prepared = f.lifecycle.restoreMutation.prepare(loaded.value); assert(prepared.result.ok);
  await f.create('D');
  const result = await f.repository.saveLifecycle(prepared.result.value); assert(!result.ok && result.error.kind === 'TagLimitReached');
});
test('simultaneous restore candidates cannot exceed quota across two DB connections', async t => {
  const f = fixture(t), a = await f.create('A'), b = await f.create('B'); await f.create('C');
  await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 }); await f.lifecycle.archive.run({ id: b.data.id, expectedVersion: 1 });
  await f.create('D'); const second = new SqliteTagRepository(f.path);
  try {
    const x = await f.repository.loadLifecycle({ id: a.data.id, expectedVersion: 2 }), y = await second.loadLifecycle({ id: b.data.id, expectedVersion: 2 }); assert(x.ok && y.ok);
    const dx = f.lifecycle.restoreMutation.prepare(x.value), dy = createLifecycleFeature(second).restoreMutation.prepare(y.value); assert(dx.result.ok && dy.result.ok);
    const results = await Promise.all([f.repository.saveLifecycle(dx.result.value), second.saveLifecycle(dy.result.value)]);
    assert.equal(results.filter(r => r.ok).length, 1); const active = f.repository.list('g'); assert(active.ok && active.value.length === 3);
  } finally { second.close(); }
});
test('same prepared archive replays, but an old archive cannot undo a later restore', async t => {
  const f = fixture(t), a = await f.create('A'), loaded = await f.repository.loadLifecycle({ id: a.data.id, expectedVersion: 1 }); assert(loaded.ok);
  const first = await f.lifecycle.archiveMutation.run(loaded.value); assert(first.ok);
  assert.deepEqual(await f.lifecycle.archiveMutation.run(loaded.value), first);
  await f.lifecycle.restore.run({ id: a.data.id, expectedVersion: 2 });
  const stale = await f.lifecycle.archiveMutation.run(loaded.value); assert(!stale.ok && stale.error.kind === 'SaveConflict');
});
test('archive transaction rolls back flag, version and receipt on injected receipt failure', async t => {
  const f = fixture(t), a = await f.create('A'), db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER fail_lifecycle BEFORE INSERT ON mutation_receipts WHEN NEW.operation_id LIKE 'archive:%' BEGIN SELECT RAISE(ABORT,'injected'); END");
    const failed = await f.lifecycle.archive.run({ id: a.data.id, expectedVersion: 1 }); assert(!failed.ok && failed.error.kind === 'RepositoryUnavailable');
    const row = db.prepare('SELECT archived,version FROM tags WHERE id=?').get(a.data.id); assert.equal(row?.archived, 0); assert.equal(row?.version, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM mutation_receipts WHERE operation_id LIKE 'archive:%'").get()?.n, 0);
  } finally { db.close(); }
});
test('schema v1 migrates to v2 without losing tags or versions, and reopening preserves archive', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'business-react-migration-')), path = join(dir, 'old.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,version INTEGER NOT NULL,max_tags INTEGER NOT NULL);
    CREATE TABLE tags(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,label TEXT NOT NULL,label_key TEXT NOT NULL,icon_json TEXT NOT NULL,sort_order INTEGER NOT NULL,version INTEGER NOT NULL,UNIQUE(group_id,label_key));
    CREATE TABLE mutation_receipts(operation_id TEXT PRIMARY KEY,signature TEXT NOT NULL,output_json TEXT NOT NULL);
    INSERT INTO groups VALUES('g','メイン',1,3); INSERT INTO tags VALUES('old','g','Existing','Existing','null',0,7); PRAGMA user_version=1;`); old.close();
  const migrated = new SqliteTagRepository(path);
  try {
    const rows = migrated.list('g'); assert(rows.ok && rows.value[0]?.version === 7);
    assert((await createLifecycleFeature(migrated).archive.run({ id: 'old', expectedVersion: 7 })).ok);
  } finally { migrated.close(); }
  const reopened = new SqliteTagRepository(path);
  try { const rows = reopened.list('g', true); assert(rows.ok && rows.value[0]?.version === 8); }
  finally { reopened.close(); }
});
test('HTTP exposes archive/restore, separate lists and exhaustive errors', async t => {
  const f = fixture(t), a = await f.create('A'), app = createApp(f.repository);
  const post = (name: string, version: unknown) => app.request(`/api/tags/${a.data.id}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: version }) });
  assert.equal((await post('archive', '1')).status, 400);
  assert.equal((await post('restore', 1)).status, 409);
  assert.equal((await post('archive', 1)).status, 200);
  assert.equal((await (await app.request('/api/tags')).json()).value.length, 0);
  assert.equal((await (await app.request('/api/tags?archived=true')).json()).value.length, 1);
  assert.equal((await post('restore', 2)).status, 200);
});
async function plainTransition(repository: SqliteTagRepository, operation: 'archive' | 'restore', id: string, expectedVersion: number) {
  const loaded = await repository.loadLifecycle({ id, expectedVersion }); if (!loaded.ok) return loaded;
  if (operation === 'archive') {
    const active = requireActive(loaded.value); if (!active.ok) return active;
    const change = archiveTag(active.value); if (!change.ok) return change;
    return repository.saveLifecycle(change.value);
  }
  const archived = requireArchived(loaded.value); if (!archived.ok) return archived;
  const allowed = checkRestoreCapacity(archived.value); if (!allowed.ok) return allowed;
  const change = restoreArchivedTag(allowed.value); if (!change.ok) return change;
  return repository.saveLifecycle(change.value);
}
test('plain TS baseline has the same state transitions and errors', async t => {
  const f = fixture(t), a = await f.create('A');
  const archived = await plainTransition(f.repository, 'archive', a.data.id, 1); assert(archived.ok && archived.value.kind === 'archived');
  const again = await plainTransition(f.repository, 'archive', a.data.id, 2); assert(!again.ok && again.error.kind === 'AlreadyArchived');
  const restored = await plainTransition(f.repository, 'restore', a.data.id, 2); assert(restored.ok && restored.value.kind === 'active');
});
function typeAssertions(command: LifecycleCommand, restore: RestoreChange) {
  // @ts-expect-error Archive needs proof that the current tag is active.
  archiveTag(command);
  // @ts-expect-error Restore must pass archived-state and capacity checks.
  workflow('state', requireArchived).then('restore', restoreArchivedTag);
  // @ts-expect-error A loaded command is not an archive decision.
  const wrong = bindMutation({ workflow: workflow('active', requireActive).then('archive', archiveTag), operation: 'bad', save: async (_: RestoreChange) => ok(restore) });
  return wrong;
}
void typeAssertions;

test('corrupted persisted lifecycle flag is rejected instead of becoming active', async t => {
  const f = fixture(t), tag = await f.create('A');
  const db = new DatabaseSync(f.path);
  try {
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE tags SET archived=2 WHERE id=?').run(tag.data.id);
    assert.deepEqual(await f.repository.loadLifecycle({ id: tag.data.id, expectedVersion: 1 }), err({ kind: 'CorruptStoredTag' }));
  } finally { db.close(); }
});
