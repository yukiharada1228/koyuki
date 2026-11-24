import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { SqliteTagRepository } from './tags/sqlite.js';
import { createTagFeature } from './tags/feature.js';
import { createApp } from './web/app.js';
import { createWorkflow, updateWorkflow } from './tags/feature.js';
import { Repository } from './tags/repository.js';
import { workflow } from './framework/index.js';
const input = (label = 'VIP', groupId = 'g') => ({ groupId, label, icon: null });
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'business-react-http-')), path = join(directory, 'tags.sqlite');
  const repository = new SqliteTagRepository(path), app = createApp(repository);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (method: string, url: string, body?: unknown) => app.request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { path, repository, app, request };
}
test('web: create, list and update work through Hono with SQLite', async t => {
  const f = fixture(t), created = await f.request('POST', '/api/tags', input()); assert.equal(created.status, 201);
  const body = await created.json(); assert.equal(body.value.data.label, 'VIP');
  assert.deepEqual(body.trace.map((s: { step: string }) => s.step), ['load-create', 'validate-create', 'check-unique-label', 'check-quota', 'create-tag', 'tag.create.v1']);
  const listing = await (await f.request('GET', '/api/tags')).json(); assert.equal(listing.value.length, 1);
  const updated = await f.request('PATCH', `/api/tags/${body.value.data.id}`, { ...input('Regular'), expectedVersion: 1 });
  assert.equal(updated.status, 200); const saved = await updated.json(); assert.equal(saved.value.data.version, 2);
  assert.equal(saved.value.data.sortOrder, 0); assert.equal(saved.plan.operation, 'tag.update.v1');
});
test('web: duplicate names fail in the pure rule before saving', async t => {
  const f = fixture(t); await f.request('POST', '/api/tags', input());
  const response = await f.request('POST', '/api/tags', input(' VIP ')); assert.equal(response.status, 409);
  const body = await response.json(); assert.equal(body.error.kind, 'DuplicateLabel');
  assert.deepEqual(body.trace.at(-1), { step: 'check-unique-label', status: 'error' });
  assert.equal(body.plan, null); const listing = f.repository.list('g'); assert(listing.ok && listing.value.length === 1);
});
test('web: Unicode normalization is explicit and names remain case sensitive', async t => {
  const f = fixture(t); assert.equal((await f.request('POST', '/api/tags', input('é'))).status, 201);
  assert.equal((await f.request('POST', '/api/tags', input('e\u0301'))).status, 409);
  assert.equal((await f.request('POST', '/api/tags', input('É'))).status, 201);
});
test('web: the same label is allowed in different groups', async t => {
  const f = fixture(t); assert.equal((await f.request('POST', '/api/tags', input())).status, 201);
  assert.equal((await f.request('POST', '/api/tags', input('VIP', 'other'))).status, 201);
});
test('web: unchanged own name is allowed but rename to another tag is rejected', async t => {
  const f = fixture(t);
  const first = await (await f.request('POST', '/api/tags', input('A'))).json(); await f.request('POST', '/api/tags', input('B'));
  const unchanged = await f.request('PATCH', `/api/tags/${first.value.data.id}`, { ...input('A'), expectedVersion: 1 }); assert.equal(unchanged.status, 200);
  const duplicate = await f.request('PATCH', `/api/tags/${first.value.data.id}`, { ...input('B'), expectedVersion: 2 });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.kind, 'DuplicateLabel');
});
test('web: stale browser version fails instead of overwriting a newer edit', async t => {
  const f = fixture(t), first = await (await f.request('POST', '/api/tags', input('A'))).json();
  const path = `/api/tags/${first.value.data.id}`;
  assert.equal((await f.request('PATCH', path, { ...input('New'), expectedVersion: 1 })).status, 200);
  const stale = await f.request('PATCH', path, { ...input('Stale'), expectedVersion: 1 });
  assert.equal(stale.status, 409); const body = await stale.json(); assert.equal(body.error.kind, 'SaveConflict');
  assert.deepEqual(body.trace, [{ step: 'load-update', status: 'error' }]);
  const listing = f.repository.list('g'); assert(listing.ok && listing.value[0]?.label === 'New');
});
test('web: quota prevents a fourth tag', async t => {
  const f = fixture(t); for (const label of ['A', 'B', 'C']) assert.equal((await f.request('POST', '/api/tags', input(label))).status, 201);
  const full = await f.request('POST', '/api/tags', input('D')); assert.equal(full.status, 409);
  assert.equal((await full.json()).error.kind, 'TagLimitReached');
});
test('web: HTTP input errors, validation failures and missing resources are mapped', async t => {
  const f = fixture(t);
  for (const body of [null, [], {}, { groupId: 42 }]) assert.equal((await f.request('POST', '/api/tags', body)).status, 400);
  const malformed = await f.app.request('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }); assert.equal(malformed.status, 400);
  const invalid = await f.request('POST', '/api/tags', input('')); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.kind, 'ValidationError');
  assert.equal((await f.request('PATCH', '/api/tags/missing', input())).status, 400);
  assert.equal((await f.request('PATCH', '/api/tags/missing', { ...input(), expectedVersion: 1 })).status, 404);
  assert.equal((await f.request('GET', '/api/tags?groupId=missing')).status, 404);
  const tooLarge = await f.request('POST', '/api/tags', { ...input(), extra: 'a'.repeat(20_000) }); assert.equal(tooLarge.status, 413);
});
test('sqlite: independent connections cannot save two candidates with the same name', async t => {
  const f = fixture(t), second = new SqliteTagRepository(f.path);
  try {
    const x = await f.repository.loadCreate(input()), y = await second.loadCreate(input()); assert(x.ok && y.ok);
    const a = createWorkflow.run(x.value), b = createWorkflow.run(y.value); assert(a.ok && b.ok);
    assert((await f.repository.saveCreated(a.value)).ok);
    const result = await second.saveCreated(b.value); assert(!result.ok && result.error.kind === 'DuplicateLabel');
    const listing = f.repository.list('g'); assert(listing.ok && listing.value.length === 1);
  } finally { second.close(); }
});
test('sqlite: concurrent creates with distinct labels reject stale quota/order snapshot', async t => {
  const f = fixture(t), second = new SqliteTagRepository(f.path);
  try {
    const x = await f.repository.loadCreate(input('A')), y = await second.loadCreate(input('B')); assert(x.ok && y.ok);
    const a = createWorkflow.run(x.value), b = createWorkflow.run(y.value); assert(a.ok && b.ok);
    assert((await f.repository.saveCreated(a.value)).ok);
    const result = await second.saveCreated(b.value); assert(!result.ok && result.error.kind === 'SaveConflict');
  } finally { second.close(); }
});
test('sqlite: independent stale updates reject the loser', async t => {
  const f = fixture(t), second = new SqliteTagRepository(f.path);
  try {
    const saved = await createTagFeature(f.repository).createAction(input()); assert(saved.ok);
    const id = saved.value.data.id;
    const x = await f.repository.loadUpdate({ ...input('A'), id }), y = await second.loadUpdate({ ...input('B'), id }); assert(x.ok && y.ok);
    const a = updateWorkflow.run(x.value), b = updateWorkflow.run(y.value); assert(a.ok && b.ok);
    assert((await f.repository.saveUpdated(a.value)).ok);
    const result = await second.saveUpdated(b.value); assert(!result.ok && result.error.kind === 'SaveConflict');
  } finally { second.close(); }
});
test('sqlite: UNIQUE constraint protects writes even when pure workflow is bypassed', async t => {
  const f = fixture(t); await f.request('POST', '/api/tags', input());
  const db = new DatabaseSync(f.path);
  try {
    assert.throws(() => db.prepare('INSERT INTO tags(id,group_id,label,label_key,icon_json,sort_order,version) VALUES(?,?,?,?,?,?,?)').run('bypass', 'g', 'VIP', 'VIP', 'null', 9, 1), /UNIQUE constraint failed/);
  } finally { db.close(); }
});
test('sqlite: receipt failure rolls back tag, group version and receipt together', async t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  try {
    const loaded = await f.repository.loadCreate(input()); assert(loaded.ok);
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const feature = createTagFeature(f.repository); const failed = await feature.create.run(loaded.value);
    assert(!failed.ok && failed.error.kind === 'RepositoryUnavailable');
    assert.equal(db.prepare('SELECT count(*) AS n FROM tags').get()?.n, 0);
    assert.equal(db.prepare("SELECT version FROM groups WHERE id='g'").get()?.version, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM mutation_receipts').get()?.n, 0);
    db.exec('DROP TRIGGER fail_receipt'); assert((await feature.create.run(loaded.value)).ok);
  } finally { db.close(); }
});
test('sqlite: commit receipts survive a fresh connection and reject old replay after later update', async t => {
  const f = fixture(t), loaded = await f.repository.loadCreate(input()); assert(loaded.ok);
  const first = await createTagFeature(f.repository).create.run(loaded.value); assert(first.ok);
  const reopened = new SqliteTagRepository(f.path);
  try {
    const feature = createTagFeature(reopened); assert.deepEqual(await feature.create.run(loaded.value), first);
    assert((await feature.updateAction({ ...input('Later'), id: first.value.data.id })).ok);
    const replay = await feature.create.run(loaded.value); assert(!replay.ok && replay.error.kind === 'SaveConflict');
  } finally { reopened.close(); }
});
test('sqlite: committed tags are readable from a fresh Node process', async t => {
  const f = fixture(t); await f.request('POST', '/api/tags', input());
  const moduleUrl = pathToFileURL(resolve('src/tags/sqlite.ts')).href;
  const code = `const {SqliteTagRepository}=await import(${JSON.stringify(moduleUrl)}); const r=new SqliteTagRepository(${JSON.stringify(f.path)}); console.log(JSON.stringify(r.list('g')));r.close();`;
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), encoding: 'utf8' }));
  assert.equal(result.value[0].label, 'VIP');
});
test('HTTP server: real TCP requests reach the Hono/SQLite app', async t => {
  const f = fixture(t);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) });
    assert.equal(response.status, 201); assert.equal((await response.json()).value.data.label, 'VIP');
    const page = await fetch(`http://127.0.0.1:${address.port}/`); assert.equal(page.status, 200); assert((await page.text()).includes('Tag Studio'));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('duplicate rule works in the in-memory adapter and generic workflow also handles another domain', async () => {
  const feature = createTagFeature(new Repository()); assert((await feature.createAction(input())).ok);
  const duplicate = await feature.createAction(input()); assert(!duplicate.ok && duplicate.error.kind === 'DuplicateLabel');
  const other = workflow('length', (value: string) => ({ ok: true as const, value: value.length }))
    .then('double', value => ({ ok: true as const, value: value * 2 }));
  assert.deepEqual(other.run('abc'), { ok: true, value: 6 });
});

test('web: simultaneous duplicate create requests leave exactly one tag', async t => {
  const f = fixture(t);
  const responses = await Promise.all([f.request('POST', '/api/tags', input()), f.request('POST', '/api/tags', input())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  const listing = f.repository.list('g'); assert(listing.ok && listing.value.length === 1);
});
test('web: corrupted SQLite data fails hydration with a typed service error', async t => {
  const f = fixture(t); await f.request('POST', '/api/tags', input());
  const db = new DatabaseSync(f.path);
  try { db.exec("UPDATE tags SET icon_json='not-json'"); } finally { db.close(); }
  const response = await f.request('GET', '/api/tags'); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.kind, 'CorruptStoredTag');
});
