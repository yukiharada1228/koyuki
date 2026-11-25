import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { err } from 'koyuki';
import { SqliteLeave } from './repository.js';
import { createLeaveHttp, bearerAuthenticator, type HttpRepository, type HttpReportRecord } from './http.js';
import type { Actor, Input } from './domain.js';
const credentials = new Map<string, Actor>([
  ['owner-token', { id: 'owner', role: 'employee', active: true }],
  ['manager-token', { id: 'boss', role: 'manager', active: true }],
  ['other-token', { id: 'other', role: 'employee', active: true }],
  ['inactive-token', { id: 'owner', role: 'employee', active: false }],
]);
const authenticate = bearerAuthenticator(credentials);
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-http-')), path = join(dir, 'db.sqlite');
  const repository = new SqliteLeave(path); assert(repository.seed('owner', 5).ok);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, repository, app: createLeaveHttp(repository, authenticate) };
}
function post(app: ReturnType<typeof createLeaveHttp>, operation: 'submit' | 'approve' | 'withdraw', body: unknown,
  key = 'request-1', token = 'owner-token', leaveId = 'leave-1', employee = 'owner') {
  return app.request(`/accounts/${employee}/leaves/${leaveId}/${operation}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
}
const body = { expectedVersion: 1, days: 3 };
test('HTTP requests submit, approve, withdraw and read durable balance', async t => {
  const { app } = fixture(t);
  const submitted = await post(app, 'submit', body); assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).value.kind, 'committed');
  assert.equal((await post(app, 'approve', { expectedVersion: 2 }, 'approve-1', 'manager-token')).status, 200);
  assert.equal((await post(app, 'submit', { expectedVersion: 3, days: 2 }, 'submit-2', 'owner-token', 'leave-2')).status, 200);
  assert.equal((await post(app, 'withdraw', { expectedVersion: 4 }, 'withdraw-2', 'owner-token', 'leave-2')).status, 200);
  const response = await app.request('/accounts/owner', { headers: { authorization: 'Bearer owner-token' } });
  const value = (await response.json()).value;
  assert.equal(value.account.version, 5);
  assert.deepEqual(value.balance, { granted: 5, reserved: 0, used: 3, available: 2 });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('replay preserves the historical response and does not replace the current GET representation', async t => {
  const { app, repository } = fixture(t);
  assert.equal((await post(app, 'submit', body)).status, 200);
  assert.equal((await post(app, 'approve', { expectedVersion: 2 }, 'approve', 'manager-token')).status, 200);
  const replay = await post(app, 'submit', body);
  assert.equal(replay.status, 200);
  const replayed = (await replay.json()).value;
  assert.equal(replayed.kind, 'replayed'); assert.equal(replayed.value.version, 2);
  const state = repository.read('owner'); assert(state.ok); assert.equal(state.value.version, 3);
  assert.equal((await post(app, 'submit', { ...body, days: 2 })).status, 409);
  assert.equal((await post(app, 'withdraw', { expectedVersion: 1 }, 'request-1')).status, 409);
});
test('authentication and account access run before receipt lookup, even for a known key', async t => {
  const { repository, app } = fixture(t);
  assert.equal((await post(app, 'submit', body)).status, 200);
  let lookups = 0, loads = 0;
  const oldReceipt = repository.receipt.bind(repository), oldLoad = repository.load.bind(repository);
  repository.receipt = r => { lookups++; return oldReceipt(r); };
  repository.load = async (input, actor) => { loads++; return oldLoad(input, actor); };
  for (const [token, status] of [['missing', 401], ['other-token', 403], ['inactive-token', 403]] as const) {
    assert.equal((await post(app, 'submit', body, 'request-1', token)).status, status);
  }
  const noAuth = await app.request('/accounts/owner'); assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await app.request('/accounts/owner', { headers: { authorization: 'Bearer other-token' } })).status, 403);
  assert.equal(lookups, 0); assert.equal(loads, 0);
});
test('revoked authentication cannot retrieve an already saved success', async t => {
  const { repository } = fixture(t); let valid = true, receipts = 0;
  const app = createLeaveHttp(repository, request => valid ? authenticate(request) : null);
  const old = repository.receipt.bind(repository); repository.receipt = r => { receipts++; return old(r); };
  assert.equal((await post(app, 'submit', body)).status, 200); const count = receipts;
  valid = false;
  assert.equal((await post(app, 'submit', body)).status, 401); assert.equal(receipts, count);
});
test('malformed bodies, forged identity, media type, keys and oversized bodies never reach the domain', async t => {
  const { app, repository } = fixture(t); let loads = 0, receipts = 0;
  const oldLoad = repository.load.bind(repository), oldReceipt = repository.receipt.bind(repository);
  repository.load = async (input, actor) => { loads++; return oldLoad(input, actor); };
  repository.receipt = r => { receipts++; return oldReceipt(r); };
  for (const invalid of [null, [], {}, { ...body, days: '3' }, { ...body, days: 0 }, { ...body, days: 1.5 }, { ...body, expectedVersion: 0 }, { ...body, actor: { role: 'manager' } }, { ...body, requestId: 'forged' }]) {
    assert.equal((await post(app, 'submit', invalid)).status, 400);
  }
  assert.equal((await post(app, 'submit', body, '')).status, 400);
  assert.equal((await post(app, 'submit', body, 'x'.repeat(201))).status, 400);
  for (const [contentType, payload, status] of [['application/json', '{bad', 400], ['text/plain', JSON.stringify(body), 415], ['application/json', 'x'.repeat(4097), 413]] as const) {
    const response = await app.request('/accounts/owner/leaves/leave-1/submit', { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': contentType, 'Idempotency-Key': 'bad' }, body: payload });
    assert.equal(response.status, status);
  }
  assert.equal(loads, 0); assert.equal(receipts, 0);
});
test('business and persistence failures map to HTTP codes without exposing adapter exceptions', async t => {
  const { repository, app } = fixture(t);
  assert.equal((await post(app, 'submit', { ...body, days: 6 })).status, 422);
  assert.equal((await post(app, 'submit', body)).status, 200);
  assert.equal((await post(app, 'approve', { expectedVersion: 2 }, 'self')).status, 403);
  assert.equal((await post(app, 'submit', { expectedVersion: 1, days: 1 }, 'stale', 'owner-token', 'other-leave')).status, 409);
  assert.equal((await post(app, 'withdraw', { expectedVersion: 2 }, 'withdraw')).status, 200);
  assert.equal((await post(app, 'approve', { expectedVersion: 3 }, 'terminal', 'manager-token')).status, 409);
  assert.equal((await app.request('/accounts/missing', { headers: { authorization: 'Bearer manager-token' } })).status, 404);
  repository.receipt = () => err({ kind: 'StorageUnavailable' });
  assert.equal((await post(app, 'submit', body)).status, 503);
  repository.receipt = () => { throw new Error('private database information'); };
  const failed = await post(app, 'submit', body); assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, error: { kind: 'InternalError' } });
});
test('unknown commit is resolved by receipt and traces preserve the failed original attempt', async t => {
  const { repository } = fixture(t); let saves = 0;
  const save = repository.save.bind(repository); repository.save = async (request, change) => {
    saves++; const result = await save(request, change); return result.ok ? err({ kind: 'StorageUnavailable' }) : result;
  };
  const reports: HttpReportRecord[] = [];
  const app = createLeaveHttp(repository, authenticate, { onReport: record => { reports.push(record); } });
  const response = await post(app, 'submit', body); assert.equal(response.status, 200);
  assert.equal((await response.json()).value.kind, 'replayed'); assert.equal(saves, 1);
  const report = reports[0]!.report;
  assert(report.result.ok); assert(report.attempt && !report.attempt.result.ok);
  assert.equal(report.attempt.result.error.kind, 'StorageUnavailable');
  assert.deepEqual(report.trace.at(-1), { kind: 'lookup', phase: 'after-error', status: 'found' });
});
test('an observer failure cannot change a successful response or trigger another save', async t => {
  const { repository } = fixture(t);
  const app = createLeaveHttp(repository, authenticate, { onReport: async () => { throw new Error('telemetry offline'); } });
  const response = await post(app, 'submit', body); assert.equal(response.status, 200);
  assert.equal((await response.json()).value.kind, 'committed');
  await new Promise<void>(resolve => setImmediate(resolve));
  const state = repository.read('owner'); assert(state.ok); assert.equal(state.value.version, 2);
});
function simultaneous(path: string) {
  const repositories = [new SqliteLeave(path), new SqliteLeave(path)];
  let arrived = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const apps = repositories.map(repository => {
    const adapter: HttpRepository = {
      read: employee => repository.read(employee), receipt: r => repository.receipt(r), save: (r, c) => repository.save(r, c),
      load: async <I extends Input>(input: I, actor: Actor) => {
        const loaded = await repository.load(input, actor);
        if (++arrived === 2) release(); await gate; return loaded;
      },
    };
    return createLeaveHttp(adapter, authenticate);
  });
  return { apps, close: () => repositories.forEach(r => r.close()) };
}
test('two connections loaded at the same version cannot oversubscribe the balance', async t => {
  const { path, repository } = fixture(t), concurrent = simultaneous(path); t.after(concurrent.close);
  const responses = await Promise.all([post(concurrent.apps[0]!, 'submit', body, 'a'), post(concurrent.apps[1]!, 'submit', body, 'b', 'owner-token', 'leave-2')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const state = repository.read('owner'); assert(state.ok); assert.equal(state.value.leaves.length, 1); assert.equal(state.value.version, 2);
});
test('simultaneous identical requests commit once and the other returns replayed', async t => {
  const { path, repository } = fixture(t), concurrent = simultaneous(path); t.after(concurrent.close);
  const responses = await Promise.all(concurrent.apps.map(app => post(app, 'submit', body)));
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const kinds = await Promise.all(responses.map(async r => (await r.json()).value.kind));
  assert.deepEqual(kinds.sort(), ['committed', 'replayed']);
  const state = repository.read('owner'); assert(state.ok); assert.equal(state.value.version, 2);
});
test('a fresh connection and app retrieve durable state and the saved receipt', async t => {
  const { app, path } = fixture(t); assert.equal((await post(app, 'submit', body)).status, 200);
  const reopened = new SqliteLeave(path); t.after(() => reopened.close());
  const fresh = createLeaveHttp(reopened, authenticate);
  const response = await post(fresh, 'submit', body); assert.equal(response.status, 200);
  assert.equal((await response.json()).value.kind, 'replayed');
  assert.equal((await fresh.request('/accounts/owner', { headers: { authorization: 'Bearer owner-token' } })).status, 200);
});
test('real TCP requests reach the Hono and SQLite adapter', async t => {
  const { app } = fixture(t), server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/accounts/owner/leaves/leave-1/submit`, { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'Idempotency-Key': 'tcp' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal((await response.json()).value.kind, 'committed');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('a business rejection trace stops at the failing requirement and performs no write', async t => {
  const { repository } = fixture(t); const records: HttpReportRecord[] = [];
  const app = createLeaveHttp(repository, authenticate, { onReport: record => { records.push(record); } });
  const response = await post(app, 'submit', { ...body, days: 6 });
  assert.equal(response.status, 422);
  const report = records[0]!.report;
  assert.deepEqual(report.attempt?.trace?.at(-1), { step: 'require-days', status: 'error' });
  assert(!report.attempt?.trace?.some(entry => entry.step === 'submit'));
  const account = repository.read('owner'); assert(account.ok); assert.equal(account.value.version, 1);
});

async function startServer(path: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', LEAVE_DB: path, LEAVE_OWNER_TOKEN: 'owner-token', LEAVE_MANAGER_TOKEN: 'manager-token' },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Server startup timed out')); }, 10000);
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited early: ${code} ${errors}`)); });
    child.stdout.on('data', chunk => {
      output += String(chunk); const match = output.match(/Leave API: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { url, stop: () => new Promise<void>((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Server exit: ${code}`)));
    child.kill('SIGTERM');
  }) };
}
test('REST and GraphQL share durable receipts across a server process restart', async t => {
  const { path } = fixture(t);
  const first = await startServer(path);
  try {
    const response = await fetch(`${first.url}/accounts/owner/leaves/leave-1/submit`, { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'Idempotency-Key': 'restart' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal((await response.json()).value.kind, 'committed');
  } finally { await first.stop(); }
  const second = await startServer(path);
  try {
    const response = await fetch(`${second.url}/accounts/owner/leaves/leave-1/submit`, { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'Idempotency-Key': 'restart' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal((await response.json()).value.kind, 'replayed');
    const current = await fetch(`${second.url}/accounts/owner`, { headers: { authorization: 'Bearer owner-token' } });
    assert.equal((await current.json()).value.account.version, 2);
    const graphql = await fetch(`${second.url}/graphql`, { method: 'POST',
      headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ query: `mutation { submit(requestId:"restart",input:{employee:"owner",leaveId:"leave-1",expectedVersion:1,days:3}) {
        ... on LeaveSuccess { kind account { version } } ... on LeaveFailure { code } } }` }),
    });
    const replay = await graphql.json();
    assert.equal(replay.data.submit.kind, 'replayed'); assert.equal(replay.data.submit.account.version, 2);
  } finally { await second.stop(); }
});
test('a thrown error after commit returns 500, then the same request recovers without another write', async t => {
  const { repository, app } = fixture(t); let writes = 0;
  const save = repository.save.bind(repository);
  repository.save = async (request, change) => { writes++; const result = await save(request, change); if (result.ok) throw new Error('response failure'); return result; };
  assert.equal((await post(app, 'submit', body)).status, 500);
  const retry = await post(app, 'submit', body); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).value.kind, 'replayed'); assert.equal(writes, 1);
});
