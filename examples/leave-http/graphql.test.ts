import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { GraphQLError } from 'graphql';
import { createLeaveGraphql } from './graphql.js';
import { bearerAuthenticator } from './http.js';
import { SqliteLeave } from './repository.js';
const identities = new Map([
  ['owner-token', { id: 'owner', role: 'employee' as const, active: true }],
  ['boss-token', { id: 'boss', role: 'manager' as const, active: true }],
  ['other-token', { id: 'other', role: 'employee' as const, active: true }],
]);
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-graphql-'));
  const repository = new SqliteLeave(join(dir, 'db.sqlite')); assert(repository.seed('owner', 5).ok);
  const app = createLeaveGraphql(repository, bearerAuthenticator(identities));
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { repository, app };
}
const selected = '__typename ... on LeaveSuccess { kind account { employee version leaves { id kind days by } balance { available reserved used } } } ... on LeaveFailure { code }';
const mutation = (name: 'submit' | 'approve' | 'withdraw') => `mutation Change($requestId: ID!, $input: ${name === 'submit' ? 'SubmitInput' : 'ChangeInput'}!) { result: ${name}(requestId: $requestId, input: $input) { ${selected} } }`;
const input = { employee: 'owner', leaveId: 'one', expectedVersion: 1, days: 3 };
function post(app: ReturnType<typeof createLeaveGraphql>, query: string, variables: unknown = {}, token = 'owner-token') {
  return app.request('/graphql', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
}
test('GraphQL executes three operations and client-selected query fields', async t => {
  const { app } = fixture(t);
  const submitted = await (await post(app, mutation('submit'), { requestId: 'one', input })).json();
  assert.equal(submitted.errors, undefined); assert.equal(submitted.data.result.kind, 'committed');
  const approved = await (await post(app, mutation('approve'), { requestId: 'approve', input: { employee: 'owner', leaveId: 'one', expectedVersion: 2 } }, 'boss-token')).json();
  assert.equal(approved.data.result.account.leaves[0].by, 'boss');
  await post(app, mutation('submit'), { requestId: 'two', input: { ...input, leaveId: 'two', days: 2, expectedVersion: 3 } });
  const withdrawn = await (await post(app, mutation('withdraw'), { requestId: 'withdraw', input: { employee: 'owner', leaveId: 'two', expectedVersion: 4 } })).json();
  assert.equal(withdrawn.data.result.account.balance.available, 2);
  const query = await (await post(app, '{ account(employee:"owner") { version balance { used } } }')).json();
  assert.deepEqual(query.data, { account: { version: 5, balance: { used: 3 } } });
});
test('queries do not run mutation workflow, lookup or save', async t => {
  const { app, repository } = fixture(t);
  repository.load = async () => assert.fail('query loaded a command');
  repository.receipt = () => assert.fail('query consulted receipt'); repository.save = async () => assert.fail('query saved');
  const response = await post(app, '{ account(employee:"owner") { employee } }');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).data, { account: { employee: 'owner' } });
});
test('top-level mutations run serially; the document is not an atomic database transaction', async t => {
  const { app, repository } = fixture(t);
  const query = `mutation { first: submit(requestId:"one",input:{employee:"owner",leaveId:"one",expectedVersion:1,days:3}) { ${selected} }
    second: submit(requestId:"two",input:{employee:"owner",leaveId:"two",expectedVersion:2,days:3}) { ${selected} } }`;
  const result = await (await post(app, query)).json();
  assert.equal(result.data.first.account.version, 2); assert.equal(result.data.second.code, 'InsufficientDays');
  const stored = repository.read('owner'); assert(stored.ok); assert.equal(stored.value.version, 2);
});
test('historical replay and current query representation remain distinct', async t => {
  const { app } = fixture(t);
  await post(app, mutation('submit'), { requestId: 'one', input });
  await post(app, mutation('withdraw'), { requestId: 'withdraw', input: { employee: 'owner', leaveId: 'one', expectedVersion: 2 } });
  const replay = await (await post(app, mutation('submit'), { requestId: 'one', input })).json();
  assert.equal(replay.data.result.kind, 'replayed'); assert.equal(replay.data.result.account.version, 2);
  assert.equal((await (await post(app, '{ account(employee:"owner") { version } }')).json()).data.account.version, 3);
  const changed = await (await post(app, mutation('submit'), { requestId: 'one', input: { ...input, days: 2 } })).json();
  assert.equal(changed.data.result.code, 'IdempotencyConflict');
});
test('schema rejects spoofed identity, wrong types and unknown operations before IO', async t => {
  const { app, repository } = fixture(t);
  repository.load = async () => assert.fail('invalid document executed'); repository.receipt = () => assert.fail('invalid document consulted receipt');
  for (const variables of [{ requestId: 'bad', input: { ...input, role: 'manager' } }, { requestId: 'bad', input: { ...input, days: '3' } }]) {
    const result = await (await post(app, mutation('submit'), variables)).json();
    assert.equal(result.data, undefined); assert(result.errors.length > 0);
  }
  const unknown = await (await post(app, 'mutation { deleteAll }')).json();
  assert.equal(unknown.data, undefined); assert(unknown.errors.length > 0);
});
test('authentication and scope precede receipt lookup, including known requests', async t => {
  const { app, repository } = fixture(t); await post(app, mutation('submit'), { requestId: 'one', input });
  repository.receipt = () => assert.fail('forbidden lookup'); repository.load = async () => assert.fail('forbidden load');
  assert.equal((await post(app, mutation('submit'), { requestId: 'one', input }, 'missing')).status, 401);
  const other = await (await post(app, mutation('submit'), { requestId: 'one', input }, 'other-token')).json();
  assert.equal(other.data.result.code, 'Forbidden');
  const query = await (await post(app, '{ account(employee:"owner") { employee } }', {}, 'other-token')).json();
  assert.equal(query.data.account, null); assert.equal(query.errors[0].extensions.code, 'Forbidden');
});
test('request identity is bound to credentials; employees cannot approve as manager', async t => {
  const { app } = fixture(t); await post(app, mutation('submit'), { requestId: 'one', input });
  const variables = { requestId: 'approve', input: { employee: 'owner', leaveId: 'one', expectedVersion: 2 } };
  assert.equal((await (await post(app, mutation('approve'), variables)).json()).data.result.code, 'Forbidden');
  const boss = await (await post(app, mutation('approve'), variables, 'boss-token')).json();
  assert.equal(boss.data.result.account.leaves[0].by, 'boss');
});
test('post-commit exceptions are sanitized and same-key retry recovers', async t => {
  const { app, repository } = fixture(t), save = repository.save.bind(repository);
  repository.save = async (...args) => { const result = await save(...args); if (result.ok) throw new Error('secret database details'); return result; };
  const failed = await (await post(app, mutation('submit'), { requestId: 'one', input })).json();
  assert.equal(failed.data, null); assert.equal(failed.errors[0].message, 'InternalError'); assert(!JSON.stringify(failed).includes('secret'));
  assert.equal((await (await post(app, mutation('submit'), { requestId: 'one', input })).json()).data.result.kind, 'replayed');
});
test('HTTP envelope rejects malformed bodies, unknown keys and oversized payloads', async t => {
  const { app } = fixture(t);
  const request = (body: string, type = 'application/json') => app.request('/graphql', { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': type }, body });
  assert.equal((await request('{')).status, 400); assert.equal((await request(JSON.stringify({ query: '{}', actor: 'boss' }))).status, 400);
  assert.equal((await request('{}', 'text/plain')).status, 415); assert.equal((await request('x'.repeat(4097))).status, 413);
});
test('real TCP GraphQL requests reach declarative commands', async t => {
  const { app } = fixture(t), server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
    body: JSON.stringify({ query: mutation('submit'), variables: { requestId: 'tcp', input } }) });
  const result = await response.json(); assert.equal(result.data.result.kind, 'committed');
});

test('operationName selects a document operation and optional null envelope fields work', async t => {
  const { app } = fixture(t);
  const response = await app.request('/graphql', { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query Other { account(employee:"missing") { version } } query Pick { account(employee:"owner") { version } }', operationName: 'Pick', variables: null }) });
  const result = await response.json(); assert.equal(result.errors, undefined); assert.deepEqual(result.data, { account: { version: 1 } });
});

test('unexpected query adapter exceptions are sanitized even if already GraphQL errors', async t => {
  const { app, repository } = fixture(t);
  repository.read = () => { throw new GraphQLError('secret storage diagnostics'); };
  const result = await (await post(app, '{ account(employee:"owner") { version } }')).json();
  assert.equal(result.data.account, null); assert.equal(result.errors[0].message, 'InternalError');
  assert(!JSON.stringify(result).includes('secret'));
});
