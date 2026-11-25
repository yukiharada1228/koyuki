import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { business, ok, err, transition } from 'koyuki';
import { validateApproval, requireApprovalLimit, approve, type Actor, type Loaded, type Change } from './domain.js';
import { inlineApproval, helperApproval } from './approval-baselines.js';
import { approved, leaveCommands as named } from './application-named.js';
import { leaveCommands, leaveApplication } from './application.js';
import { SqliteLeave } from './repository.js';
import { createLeaveHttp, type HttpReportRecord } from './http.js';
import { createLeaveGraphql } from './graphql.js';
const owner: Actor = { id: 'owner', role: 'employee', active: true };
const boss: Actor = { id: 'boss', role: 'manager', active: true };
const disabled: Actor = { ...boss, approvalEnabled: false };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type Disabled<T> = Extract<Failure<Awaited<T>>, { kind: 'ApprovalDisabled' }>;
const call = { requestId: 'approve', input: { employee: 'owner', leaveId: 'one', expectedVersion: 2 } };
async function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-auth-change-')), path = join(dir, 'db.sqlite');
  const repository = new SqliteLeave(path); assert(repository.seed('owner', 5).ok);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  assert((await leaveCommands(repository, owner).submit({ requestId: 'submit', input: { employee: 'owner', leaveId: 'one', expectedVersion: 1, days: 1 } })).ok);
  return { repository, counts() {
    const audit = new DatabaseSync(path);
    try { return { changes: audit.prepare('SELECT count(*) AS n FROM changes').get()?.n, receipts: audit.prepare('SELECT count(*) AS n FROM receipts').get()?.n }; }
    finally { audit.close(); }
  } };
}
test('all four decision styles preserve the new authorization error and legacy managers', async () => {
  for (const identity of [boss, { ...boss, approvalEnabled: true }, disabled, { ...owner, approvalEnabled: false }]) {
    const input: Loaded = { actor: identity, input: call.input,
      account: { employee: 'owner', version: 2, granted: 5, leaves: [{ id: 'one', days: 1, kind: 'pending' }] } };
    const before = structuredClone(input);
    const commands = business({ name: 'auth-study', load: async () => ok(input), save: async (change: Change) => ok(change), operations: { approve: [validateApproval, requireApprovalLimit, approve] } });
    const expected = inlineApproval(input);
    assert.deepEqual(helperApproval(input), expected); assert.deepEqual(transition(approved).run(input), expected);
    assert.deepEqual(await commands.approve(undefined), expected); assert.deepEqual(input, before);
    if (identity === disabled) assert.deepEqual(expected, err({ kind: 'ApprovalDisabled' }));
    else if (identity.id === owner.id) assert.deepEqual(expected, err({ kind: 'Forbidden' }));
    else assert(expected.ok);
  }
});
test('disabled approval stops before limit/evolution/save and creates no receipt in both Koyuki declarations', async t => {
  const { repository, counts } = await fixture(t), before = repository.read('owner');
  const commands = leaveCommands(repository, disabled), legacy = named(repository, disabled);
  const typed: Equal<Disabled<ReturnType<typeof commands.approve>>, { kind: 'ApprovalDisabled' }> = true;
  const namedTyped: Equal<Disabled<ReturnType<typeof legacy.approve.run>>, { kind: 'ApprovalDisabled' }> = true;
  type Detailed = Awaited<ReturnType<typeof commands.approve.runDetailed>>;
  const detailedTyped: Equal<Disabled<Detailed['result']>, { kind: 'ApprovalDisabled' }> = true;
  void typed; void namedTyped; void detailedTyped;
  const report = await commands.approve.runDetailed(call);
  assert.deepEqual(report.result, err({ kind: 'ApprovalDisabled' }));
  assert.deepEqual(report.attempt?.trace?.map(row => [row.step, row.status]), [['leave.approve.v1:load', 'ok'], ['run:1', 'error']]);
  assert.deepEqual(await legacy.approve.run(call), err({ kind: 'ApprovalDisabled' }));
  assert.deepEqual(repository.read('owner'), before); assert.deepEqual(counts(), { changes: 1, receipts: 1 });
  assert.deepEqual(await repository.receipt({ operation: 'approve', actor: disabled, ...call }), ok({ kind: 'missing' }));
  const injected = { ...call, input: { ...call.input, approvalEnabled: true, actor: boss } };
  assert.deepEqual(await commands.approve(injected), err({ kind: 'ApprovalDisabled' }));
  assert.deepEqual(counts(), { changes: 1, receipts: 1 });
});
test('HTTP maps the new typed failure to 403 and permission recovery is an explicit new attempt', async t => {
  const { repository, counts } = await fixture(t), reports: HttpReportRecord[] = [];
  let enabled = false;
  const app = createLeaveHttp(repository, () => ({ ...boss, approvalEnabled: enabled }), { onReport: record => { reports.push(record); } });
  const request = (requestId = 'approve', body: unknown = { expectedVersion: 2 }) => app.request('/accounts/owner/leaves/one/approve', {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(body),
  });
  const denied = await request(); assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { ok: false, error: { kind: 'ApprovalDisabled' } });
  assert.equal(reports[0]?.report.attempt?.trace?.length, 2); assert.deepEqual(counts(), { changes: 1, receipts: 1 });
  const forged = await request('forged', { expectedVersion: 2, approvalEnabled: true }); assert.equal(forged.status, 400);
  enabled = true; const accepted = await request(); assert.equal(accepted.status, 200);
  const committed = await accepted.json(); assert.equal(committed.value.kind, 'committed'); assert.deepEqual(counts(), { changes: 2, receipts: 2 });
  enabled = false; const repeated = await request(); assert.equal(repeated.status, 200);
  const replayed = await repeated.json(); assert.equal(replayed.value.kind, 'replayed'); assert.deepEqual(replayed.value.value, committed.value.value);
  assert.equal(reports.at(-1)?.report.attempt, null); assert.deepEqual(counts(), { changes: 2, receipts: 2 });
  const fresh = await request('new-approval', { expectedVersion: 3 }); assert.equal(fresh.status, 403);
  assert.deepEqual(await fresh.json(), { ok: false, error: { kind: 'ApprovalDisabled' } }); assert.deepEqual(counts(), { changes: 2, receipts: 2 });
});
test('GraphQL returns the domain code on its failure branch while permitted reads still work', async t => {
  const { repository, counts } = await fixture(t), app = createLeaveGraphql(repository, () => disabled);
  const response = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    query: 'mutation ($requestId:ID!,$input:ChangeInput!) { approve(requestId:$requestId,input:$input) { ... on LeaveFailure { code } } }', variables: call,
  }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: { approve: { code: 'ApprovalDisabled' } } });
  const query = await app.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ account(employee:"owner") { version } }' }) });
  assert.equal(query.status, 200); assert.deepEqual(await query.json(), { data: { account: { version: 2 } } });
  assert.deepEqual(counts(), { changes: 1, receipts: 1 });
});
test('Application retains its model and presents the new domain failure without a view edit', async t => {
  const { repository, counts } = await fixture(t), current = repository.read('owner'); assert(current.ok);
  const app = await leaveApplication(repository, disabled, current.value).start();
  assert((await app.dispatch({ type: 'approve', input: call })).ok);
  assert.equal(app.snapshot().state.kind, 'failed'); assert.equal(app.snapshot().view.error, 'ApprovalDisabled');
  assert.deepEqual(app.snapshot().view.account, current.value); assert.equal(app.snapshot().view.busy, false);
  assert.deepEqual(counts(), { changes: 1, receipts: 1 });
});
