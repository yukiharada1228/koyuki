import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Actor } from './domain.js';
import { SqliteLeave } from './repository.js';
import { leaveCommands as named } from './application-named.js';
import { leaveCommands as business } from './application.js';
import { createLeaveHttp, bearerAuthenticator } from './http.js';
import { createLeaveGraphql } from './graphql.js';
const owner = { id: 'owner', role: 'employee', active: true } as const;
const boss = { id: 'boss', role: 'manager', active: true } as const;

test('old declarations and the business API replay each other through REST and GraphQL after reopening SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-business-leave-migration-')), path = join(dir, 'db.sqlite');
  const call = { requestId: 'old-submit', input: { employee: 'owner', leaveId: 'one', expectedVersion: 1, days: 3 } };
  const before = new SqliteLeave(path);
  try { assert(before.seed('owner', 5).ok); assert((await named(before, owner).submit.run(call)).ok); }
  finally { before.close(); }
  const repository = new SqliteLeave(path), audit = new DatabaseSync(path);
  try {
    const authenticate = bearerAuthenticator(new Map<string, Actor>([['owner', owner], ['boss', boss]]));
    const http = createLeaveHttp(repository, authenticate), gql = createLeaveGraphql(repository, authenticate);
    const replay = await http.request('/accounts/owner/leaves/one/submit', { method: 'POST', headers: {
      authorization: 'Bearer owner', 'content-type': 'application/json', 'Idempotency-Key': call.requestId,
    }, body: JSON.stringify({ expectedVersion: 1, days: 3 }) });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).value.kind, 'replayed');
    const approval = { requestId: 'new-approve', input: { employee: 'owner', leaveId: 'one', expectedVersion: 2 } };
    const response = await gql.request('/graphql', { method: 'POST', headers: { authorization: 'Bearer boss', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation ($requestId:ID!,$input:ChangeInput!) { approve(requestId:$requestId,input:$input) { ... on LeaveSuccess { kind } ... on LeaveFailure { code } } }', variables: approval }) });
    assert.deepEqual(await response.json(), { data: { approve: { kind: 'committed' } } });
    const oldReplay = await named(repository, boss).approve.run(approval);
    assert(oldReplay.ok); assert.equal(oldReplay.value.kind, 'replayed');
    const commands = business(repository, owner);
    assert((await commands.submit({ requestId: 'new-second', input: { ...call.input, leaveId: 'two', expectedVersion: 3, days: 2 } })).ok);
    const withdrawal = { requestId: 'new-withdraw', input: { employee: 'owner', leaveId: 'two', expectedVersion: 4 } };
    assert((await commands.withdraw(withdrawal)).ok);
    const oldWithdrawal = await named(repository, owner).withdraw.run(withdrawal);
    assert(oldWithdrawal.ok); assert.equal(oldWithdrawal.value.kind, 'replayed');
    assert((await commands.submit(call)).ok);
    const current = repository.read('owner'); assert(current.ok); assert.equal(current.value.version, 5);
    assert.equal(audit.prepare('SELECT count(*) AS n FROM changes').get()?.n, 4);
    assert.equal(audit.prepare('SELECT count(*) AS n FROM receipts').get()?.n, 4);
  } finally { audit.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); }
});
