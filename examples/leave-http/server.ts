import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SqliteLeave } from './repository.js';
import { createLeaveHttp, bearerAuthenticator } from './http.js';
import { createLeaveGraphql } from './graphql.js';
const ownerToken = process.env.LEAVE_OWNER_TOKEN, managerToken = process.env.LEAVE_MANAGER_TOKEN;
if (!ownerToken || !managerToken || ownerToken === managerToken || /\s/.test(ownerToken + managerToken)) throw new Error('Set distinct LEAVE_OWNER_TOKEN and LEAVE_MANAGER_TOKEN without whitespace');
const path = resolve(process.env.LEAVE_DB ?? '.data/leave-http.sqlite');
mkdirSync(dirname(path), { recursive: true });
const repository = new SqliteLeave(path);
const seeded = repository.seed('owner', 5);
if (!seeded.ok && seeded.error.kind !== 'Conflict') { repository.close(); throw new Error('Cannot initialize leave account'); }
const authenticate = bearerAuthenticator(new Map([
  [ownerToken, { id: 'owner', role: 'employee', active: true }],
  [managerToken, { id: 'boss', role: 'manager', active: true }],
]));
const app = new Hono()
  .route('/', createLeaveGraphql(repository, authenticate))
  .route('/', createLeaveHttp(repository, authenticate));
app.notFound(c => { c.header('Cache-Control', 'no-store'); return c.json({ ok: false, error: { kind: 'NotFound' } }, 404); });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 4321) }, info => console.log(`Leave API: http://127.0.0.1:${info.port}\nSQLite: ${path}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { repository.close(); process.exit(0); }));
