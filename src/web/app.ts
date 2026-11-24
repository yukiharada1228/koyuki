import { readFile } from 'node:fs/promises';
import { programApi } from './program-api.js';
import { reactPage } from './react-page.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLifecycleFeature } from '../tags/lifecycle.js';
import { createTagFeature } from '../tags/feature.js';
import type { SqliteTagRepository } from '../tags/sqlite.js';
import { page } from './ui.js';
export function createApp(repository: SqliteTagRepository) {
  const app = new Hono(), feature = createTagFeature(repository), lifecycle = createLifecycleFeature(repository);
  app.use('/api/*', bodyLimit({ maxSize: 16_384, onError: c => c.json({ ok: false, error: { kind: 'BadRequest' } }, 413) }));
  app.use('*', async (c, next) => { await next(); c.header('X-Content-Type-Options', 'nosniff'); c.header('Cache-Control', 'no-store'); });
  app.get('/', c => c.html(page));
  app.get('/react', c => c.html(reactPage));
  app.get('/assets/tag-view.js', async c => {
    try { return c.body(await readFile(new URL('../../.build/tag-view.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }); }
    catch { return c.text('Run npm run build:view', 503); }
  });
  app.route('/api/program', programApi(repository));
  app.get('/api/groups', c => { const result = repository.listGroups(); return c.json(result, result.ok ? 200 : 503); });
  app.get('/api/tags', c => {
    const result = repository.list(c.req.query('groupId') ?? 'g', c.req.query('archived') === 'true');
    return c.json(result, result.ok ? 200 : result.error.kind === 'GroupNotFound' ? 404 : 503);
  });
  app.post('/api/tags', async c => {
    const input = await parseBody(c.req.raw); if (!input || typeof input.groupId !== 'string') return c.json({ ok: false, error: { kind: 'BadRequest' } }, 400);
    const detail = await feature.createDetailed({ groupId: input.groupId, label: input.label, icon: input.icon ?? null });
    return c.json({ ...detail.result, trace: detail.trace, plan: detail.plan }, detail.result.ok ? 201 : status(detail.result.error.kind));
  });
  app.patch('/api/tags/:id', async c => {
    const input = await parseBody(c.req.raw);
    if (!input || typeof input.groupId !== 'string' || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) return c.json({ ok: false, error: { kind: 'BadRequest' } }, 400);
    const detail = await feature.updateDetailed({ id: c.req.param('id'), groupId: input.groupId, label: input.label, icon: input.icon ?? null, expectedVersion: input.expectedVersion as number });
    return c.json({ ...detail.result, trace: detail.trace, plan: detail.plan }, detail.result.ok ? 200 : status(detail.result.error.kind));
  });
  for (const operation of ['archive', 'restore'] as const) app.post(`/api/tags/:id/${operation}`, async c => {
    const input = await parseBody(c.req.raw);
    if (!input || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) return c.json({ ok: false, error: { kind: 'BadRequest' } }, 400);
    const detail = await lifecycle[operation].runDetailed({ id: c.req.param('id'), expectedVersion: input.expectedVersion as number });
    return c.json({ ...detail.result, trace: detail.trace, plan: detail.plan }, detail.result.ok ? 200 : status(detail.result.error.kind));
  });
  app.notFound(c => c.json({ ok: false, error: { kind: 'NotFound' } }, 404));
  app.onError((error, c) => { console.error('Unexpected application error', error); return c.json({ ok: false, error: { kind: 'InternalError' } }, 500); });
  return app;
}
async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try { const value: unknown = await request.json(); return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
type ErrorOf<T> = T extends { ok: false; error: infer E } ? E : never;
type Feature = ReturnType<typeof createTagFeature>;
type Lifecycle = ReturnType<typeof createLifecycleFeature>;
type FeatureError = ErrorOf<Awaited<ReturnType<Lifecycle['archive']['run']>> | Awaited<ReturnType<Lifecycle['restore']['run']>>> | ErrorOf<Awaited<ReturnType<Feature['createAction']>> | Awaited<ReturnType<Feature['updateAction']>>>;
function status(kind: FeatureError['kind']): 400 | 404 | 409 | 503 {
  switch (kind) {
    case 'AlreadyArchived': case 'NotArchived': case 'TagArchived': case 'DuplicateLabel': case 'SaveConflict': case 'TagLimitReached': return 409;
    case 'NotFound': case 'GroupNotFound': return 404;
    case 'RepositoryUnavailable': case 'CorruptStoredTag': return 503;
    case 'ValidationError': case 'TargetMismatch': return 400;
    default: { const unhandled: never = kind; throw new Error(`UnhandledError:${unhandled}`); }
  }
}
