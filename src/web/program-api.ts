import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { SqliteTagRepository } from '../tags/sqlite.js';
import { restoreTag, type PersistedTag } from '../tags/domain.js';
import { tagProgram, type TagMessage } from '../tags/program.js';
type Session = Awaited<ReturnType<ReturnType<typeof tagProgram>['start']>>;
export function programApi(repository: SqliteTagRepository) {
  const app = new Hono();
  const sessions = new Map<string, { session: Session; touched: number }>();
  app.post('/', async c => {
    for (const [id, entry] of sessions) if (Date.now() - entry.touched > 3600000) sessions.delete(id);
    if (sessions.size >= 100) return c.json({ error: 'SessionLimit' }, 503);
    const listed = repository.list('g'); if (!listed.ok) return c.json(listed, 503);
    const tags: PersistedTag[] = [];
    for (const row of listed.value) { const tag = restoreTag(row); if (!tag.ok) return c.json(tag, 503); tags.push(tag.value); }
    const session = await tagProgram(repository, tags).start(), id = randomUUID();
    sessions.set(id, { session, touched: Date.now() });
    return c.json({ id, snapshot: session.snapshot() }, 201);
  });
  app.post('/:id', async c => {
    const entry = sessions.get(c.req.param('id')); if (!entry) return c.json({ error: 'SessionExpired' }, 404);
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'BadRequest' }, 400); }
    if (!body || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) return c.json({ error: 'BadRequest' }, 400);
    const raw = body.message;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'BadRequest' }, 400);
    const value = raw as Record<string, unknown>;
    let message: TagMessage;
    if (value.type === 'dismiss') message = { type: 'dismiss' };
    else if (value.type === 'create' || value.type === 'update') {
      if (!value.input || typeof value.input !== 'object') return c.json({ error: 'BadRequest' }, 400);
      const input = value.input as Record<string, unknown>;
      if (input.groupId !== 'g') return c.json({ error: 'BadRequest' }, 400);
      if (value.type === 'update') {
        if (typeof input.id !== 'string' || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) return c.json({ error: 'BadRequest' }, 400);
        message = { type: 'update', input: { id: input.id, expectedVersion: input.expectedVersion as number, groupId: 'g', label: input.label, icon: input.icon ?? null } };
      } else message = { type: 'create', input: { groupId: 'g', label: input.label, icon: input.icon ?? null } };
    } else return c.json({ error: 'BadRequest' }, 400); // Completion events are internal only.
    entry.touched = Date.now();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let connected = true;
        const send = (value: unknown) => { if (connected) try { controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); } catch { connected = false; } };
        const unsubscribe = entry.session.subscribe(snapshot => send({ snapshot }));
        void entry.session.dispatch(message, body.revision as number)
          .then(result => send({ result }))
          .catch(() => send({ error: 'UnexpectedFailure' }))
          .finally(() => { unsubscribe(); if (connected) { connected = false; controller.close(); } });
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
  });
  return app;
}
