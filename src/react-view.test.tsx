/** @jsxRuntime automatic */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SqliteTagRepository } from './tags/sqlite.js';
import { createApp } from './web/app.js';
import { TagList } from './react/view.js';
import { viewStore } from './react/store.js';
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'react-view-')), repository = new SqliteTagRepository(join(dir, 'tags.sqlite')), app = createApp(repository);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, repository };
}
test('view adapter caches snapshot identity and unsubscribes cleanly', () => {
  const initial = { count: 0 }, store = viewStore(initial); let updates = 0;
  const stop = store.subscribe(() => updates++);
  assert.equal(store.getSnapshot(), initial); assert.equal(store.getSnapshot(), store.getSnapshot());
  store.publish(initial); assert.equal(updates, 0);
  store.publish({ count: 1 }); assert.equal(updates, 1);
  stop(); store.publish({ count: 2 }); assert.equal(updates, 1);
});
test('JSX tag list escapes stored labels and disables editing while busy', () => {
  const markup = renderToStaticMarkup(<TagList rows={[{ id: '1', label: '<script>alert(1)</script>', version: 1 }]} disabled={true} onEdit={() => {}} />);
  assert(!markup.includes('<script>')); assert(markup.includes('&lt;script&gt;'));
  assert(markup.includes('disabled=""'));
  assert.match(renderToStaticMarkup(<TagList rows={[]} disabled={false} onEdit={() => {}} />), /まだタグがありません/);
});
test('React shell and browser bundle are served locally', async t => {
  const { app } = fixture(t);
  assert.match(await (await app.request('/react')).text(), /id="root"/);
  const asset = await app.request('/assets/tag-view.js'); assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type')!, /javascript/);
});
test('HTTP bridge streams intermediate and final program views with real SQLite writes', async t => {
  const { app, repository } = fixture(t);
  const start = await app.request('/api/program', { method: 'POST' }); assert.equal(start.status, 201);
  const { id } = await start.json();
  const dispatch = async (message: unknown, revision: number) => {
    const response = await app.request('/api/program/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, revision }) });
    assert.equal(response.status, 200); return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  };
  const frames = await dispatch({ type: 'create', input: { groupId: 'g', label: 'A', icon: { symbol: '★', color: null } } }, 0);
  assert.deepEqual(frames.filter(f => f.snapshot).map(f => f.snapshot.state.kind), ['ready', 'running', 'ready']);
  const final = frames.at(-1).result; assert(final.ok); const tag = final.value.view.rows[0];
  assert.equal(tag.label, 'A'); assert.equal(repository.list('g').ok, true);
  const edits = await dispatch({ type: 'update', input: { groupId: 'g', id: tag.id, label: 'B', icon: { symbol: '★', color: null }, expectedVersion: 1 } }, 2);
  assert.equal(edits.at(-1).result.value.view.rows[0].label, 'B');
  const rows = repository.list('g'); assert(rows.ok); assert.equal(rows.value[0]?.icon?.symbol, '★');
  const bad = await dispatch({ type: 'create', input: { groupId: 'g', label: '', icon: null } }, 4);
  assert.equal(bad.at(-1).result.value.view.error, 'ValidationError');
  const dismissed = await dispatch({ type: 'dismiss' }, 6); assert.equal(dismissed.at(-1).result.value.state.kind, 'ready');
  const stale = await dispatch({ type: 'create', input: { groupId: 'g', label: 'C' } }, 0);
  assert.equal(stale.at(-1).result.error.kind, 'StaleRevision');
});
test('network boundary rejects internal completion events and bad payloads', async t => {
  const { app } = fixture(t), { id } = await (await app.request('/api/program', { method: 'POST' })).json();
  for (const message of [{ type: 'created', result: { ok: true } }, { type: 'update', input: {} }, { type: 'create', input: { groupId: 'other' } }]) {
    const response = await app.request('/api/program/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, message }) });
    assert.equal(response.status, 400);
  }
});
