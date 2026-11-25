import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { business } from 'koyuki';
import { ok, err, transition } from 'koyuki';
import { validateApproval, requireApprovalLimit, approve, type Loaded, type Change } from './domain.js';
import { inlineApproval, helperApproval } from './approval-baselines.js';
import { approved, leaveCommands as named } from './application-named.js';
import { leaveCommands, leaveApplication } from './application.js';
import { SqliteLeave } from './repository.js';
import { createLeaveHttp, bearerAuthenticator, type HttpReportRecord } from './http.js';
import { createLeaveGraphql } from './graphql.js';
const owner = { id: 'owner', role: 'employee', active: true } as const;
const boss = { id: 'boss', role: 'manager', active: true } as const;
const authenticate = bearerAuthenticator(new Map<string, typeof owner | typeof boss>([['owner', owner], ['boss', boss]]));
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-policy-'));
  const repository = new SqliteLeave(join(dir, 'db.sqlite'));
  assert(repository.seed('owner', 5).ok);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return repository;
}
const call = (days: number) => ({ requestId: 'submit', input: { employee: 'owner', leaveId: 'one', expectedVersion: 1, days } });
const approval = { requestId: 'approve', input: { employee: 'owner', leaveId: 'one', expectedVersion: 2 } };

test('all four migrated decisions agree on limit boundaries and existing authorization failures', async () => {
  for (const scenario of ['two', 'three', 'self', 'missing'] as const) {
    const input: Loaded = { account: { employee: 'owner', version: 2, granted: 5, leaves: scenario === 'missing' ? [] : [{ id: 'one', days: scenario === 'three' ? 3 : 2, kind: 'pending' }] },
      actor: scenario === 'self' ? owner : boss, input: approval.input };
    const before = structuredClone(input);
    const commands = business({ name: 'decision-study', load: async () => ok(input), save: async (change: Change) => ok(change),
      operations: { approve: [validateApproval, requireApprovalLimit, approve] } });
    const expected = inlineApproval(input);
    assert.deepEqual(helperApproval(input), expected);
    assert.deepEqual(transition(approved).run(input), expected);
    assert.deepEqual(await commands.approve(undefined), expected);
    if (scenario === 'two') { assert(expected.ok); assert.equal(expected.value.next.leaves[0]?.kind, 'approved'); }
    else assert.deepEqual(expected, err({ kind: scenario === 'three' ? 'ApprovalLimitExceeded' : scenario === 'self' ? 'Forbidden' : 'InvalidState' }));
    assert.deepEqual(input, before);
  }
});

test('new policy failure maps to HTTP 422, stops before evolution and leaves no approval receipt', async t => {
  const repository = fixture(t); assert((await leaveCommands(repository, owner).submit(call(3))).ok);
  const reports: HttpReportRecord[] = [];
  const app = createLeaveHttp(repository, authenticate, { onReport: report => { reports.push(report); } });
  const response = await app.request('/accounts/owner/leaves/one/approve', { method: 'POST', headers: {
    authorization: 'Bearer boss', 'content-type': 'application/json', 'Idempotency-Key': 'approve',
  }, body: JSON.stringify({ expectedVersion: 2 }) });
  assert.equal(response.status, 422); assert.deepEqual(await response.json(), { ok: false, error: { kind: 'ApprovalLimitExceeded' } });
  assert.deepEqual(reports[0]?.report.attempt?.trace?.map(entry => [entry.step, entry.status]), [['leave.approve.v1:load', 'ok'], ['run:1', 'ok'], ['run:2', 'error']]);
  const stored = repository.read('owner'); assert(stored.ok); assert.equal(stored.value.version, 2);
  assert.deepEqual(await repository.receipt({ operation: 'approve', actor: boss, ...approval }), ok({ kind: 'missing' }));
});

test('GraphQL exposes the newly mapped enum failure; two days still approve and replay', async t => {
  const repository = fixture(t); assert((await leaveCommands(repository, owner).submit(call(3))).ok);
  const app = createLeaveGraphql(repository, authenticate);
  const response = await app.request('/graphql', { method: 'POST', headers: { authorization: 'Bearer boss', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'mutation ($requestId:ID!,$input:ChangeInput!) { approve(requestId:$requestId,input:$input) { ... on LeaveFailure { code } } }', variables: approval }) });
  assert.deepEqual(await response.json(), { data: { approve: { code: 'ApprovalLimitExceeded' } } });
  const second = fixture(t); assert((await leaveCommands(second, owner).submit(call(2))).ok);
  const result = await leaveCommands(second, boss).approve(approval);
  assert(result.ok); assert.equal(result.value.kind, 'committed');
  const replay = await named(second, boss).approve.run(approval);
  assert(replay.ok); assert.equal(replay.value.kind, 'replayed'); assert.deepEqual(result.value.value, replay.value.value);
});

test('Application preserves the account and presents the new typed failure without view changes', async t => {
  const repository = fixture(t); assert((await leaveCommands(repository, owner).submit(call(3))).ok);
  const current = repository.read('owner'); assert(current.ok);
  const app = await leaveApplication(repository, boss, current.value).start();
  assert((await app.dispatch({ type: 'approve', input: approval })).ok);
  assert.equal(app.snapshot().state.kind, 'failed'); assert.equal(app.snapshot().view.error, 'ApprovalLimitExceeded');
  assert.deepEqual(app.snapshot().view.account, current.value);
});

test('a success committed before the policy change remains replayable without reapplying new rules', async () => {
  const path = join(process.cwd(), 'historical.sqlite'), repository = new SqliteLeave(path), audit = new DatabaseSync(path);
  try {
    const result = await leaveCommands(repository, boss).approve({ ...approval, requestId: 'before-policy-approve' });
    assert(result.ok); assert.equal(result.value.kind, 'replayed'); assert.equal(result.value.value.leaves[0]?.days, 3);
    assert.equal(audit.prepare('SELECT count(*) AS n FROM changes').get()?.n, 2);
    assert.equal(audit.prepare('SELECT count(*) AS n FROM receipts').get()?.n, 2);
  } finally { audit.close(); repository.close(); }
});
