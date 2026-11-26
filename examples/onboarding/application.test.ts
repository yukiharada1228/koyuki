import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpenses } from './application.js';
import { createHost } from './host.js';
import type { Actor, Draft, Submitted, Approved, Rejected, Failure, Expense } from './contracts.js';
import type { Result } from 'koyuki';
const employee: Actor = { id: 'owner', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };
const draft: Draft = { id: 'e1', version: 1, ownerId: 'owner', amountCents: 200, state: 'draft' };
const submitted: Submitted = { ...draft, state: 'submitted', version: 2, submittedBy: 'owner', approverId: 'boss' };
const input = { id: 'e1', expectedVersion: 2 };
function client(initial: Expense, identity = manager) { const host = createHost(initial); return { host, api: createExpenses(host.ports(identity)) }; }
test('submit then approve preserves fields, records actors, advances versions and saves once per operation', async () => {
  const host = createHost(draft), owner = createExpenses(host.ports(employee)), boss = createExpenses(host.ports(manager));
  assert.deepEqual(host.counts(), { loads: 0, saves: 0, writes: 0 });
  assert.deepEqual(await owner.submit({ id: 'e1', expectedVersion: 1, approverId: 'boss' }), { ok: true, value: submitted });
  const report = await boss.approve.runDetailed(input);
  assert.deepEqual(report.result, { ok: true, value: { ...submitted, state: 'approved', version: 3, approvedBy: 'boss' } });
  assert(report.trace.length >= 3, 'load, at least one domain rule, and save are observed');
  assert(report.trace.every(row => row.status === 'ok'));
  assert.deepEqual(host.counts(), { loads: 2, saves: 2, writes: 2 }); assert.equal(host.row().state, 'approved');
  assert.deepEqual(draft, { id: 'e1', version: 1, ownerId: 'owner', amountCents: 200, state: 'draft' });
});
test('reject trims its reason and keeps submitter and approver evidence', async () => {
  const { host, api } = client(submitted);
  assert.deepEqual(await api.reject({ ...input, reason: ' missing receipt ' }), { ok: true, value: { ...submitted, state: 'rejected', version: 3, rejectedBy: 'boss', reason: 'missing receipt' } });
  assert.deepEqual(host.counts(), { loads: 1, saves: 1, writes: 1 });
});
test('inactive actors are denied before version or state checks', async () => {
  const { host, api } = client(draft, { ...manager, active: false });
  assert.deepEqual(await api.approve({ id: 'e1', expectedVersion: 0 }), { ok: false, error: { kind: 'Denied' } });
  assert.equal(host.counts().saves, 0);
});
test('wrong owners, roles, assigned managers and self-approval are denied', async () => {
  const other = client(draft, { ...employee, id: 'other' });
  assert.deepEqual(await other.api.submit({ id: 'e1', expectedVersion: 1, approverId: 'boss' }), { ok: false, error: { kind: 'Denied' } });
  for (const [row, identity] of [[submitted, employee], [submitted, { ...manager, id: 'other' }], [{ ...submitted, approverId: 'owner' }, { ...manager, id: 'owner' }]] as const) {
    const { host, api } = client(row, identity);
    assert.deepEqual(await api.approve(input), { ok: false, error: { kind: 'Denied' } });
    assert.deepEqual(await api.reject({ ...input, reason: 'reason' }), { ok: false, error: { kind: 'Denied' } });
    assert.equal(host.counts().saves, 0);
  }
});
test('invalid amounts and approver IDs cannot be submitted', async () => {
  for (const amountCents of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const { host, api } = client({ ...draft, amountCents }, employee);
    assert.deepEqual(await api.submit({ id: 'e1', expectedVersion: 1, approverId: 'boss' }), { ok: false, error: { kind: 'InvalidInput' } });
    assert.equal(host.counts().saves, 0);
  }
  for (const approverId of ['', ' boss ', 'owner']) {
    const { host, api } = client(draft, employee);
    assert.deepEqual(await api.submit({ id: 'e1', expectedVersion: 1, approverId }), { ok: false, error: { kind: 'InvalidInput' } });
    assert.equal(host.counts().saves, 0);
  }
});
test('valid amount and rejection-length boundaries remain accepted', async () => {
  for (const amountCents of [1, Number.MAX_SAFE_INTEGER]) {
    const { api } = client({ ...draft, amountCents }, employee);
    const result = await api.submit({ id: 'e1', expectedVersion: 1, approverId: 'boss' });
    assert(result.ok); assert.equal(result.value.amountCents, amountCents);
  }
  const { api } = client(submitted);
  const reason = 'x'.repeat(500), result = await api.reject({ ...input, reason: ` ${reason} ` });
  assert(result.ok); assert.equal(result.value.reason, reason);
});
test('version validation precedes state and permission, without saving', async () => {
  for (const [expectedVersion, kind] of [[0, 'InvalidInput'], [1.5, 'InvalidInput'], [Number.NaN, 'InvalidInput'], [Number.POSITIVE_INFINITY, 'InvalidInput'], [1, 'Conflict']] as const) {
    const { host, api } = client(submitted, employee);
    assert.deepEqual(await api.approve({ id: 'e1', expectedVersion }), { ok: false, error: { kind } });
    assert.deepEqual(host.row(), submitted); assert.equal(host.counts().saves, 0);
  }
});
test('terminal or unsubmitted states reject further approval or rejection', async () => {
  for (const row of [draft, { ...submitted, state: 'approved', approvedBy: 'boss' }, { ...submitted, state: 'rejected', rejectedBy: 'boss', reason: 'reason' }] as const) {
    const { host, api } = client(row);
    const request = { id: row.id, expectedVersion: row.version };
    assert.deepEqual(await api.approve(request), { ok: false, error: { kind: 'WrongState' } });
    assert.deepEqual(await api.reject({ ...request, reason: 'reason' }), { ok: false, error: { kind: 'WrongState' } });
    assert.equal(host.counts().saves, 0);
  }
  const { host, api } = client(submitted, employee);
  assert.deepEqual(await api.submit({ ...input, approverId: 'boss' }), { ok: false, error: { kind: 'WrongState' } });
  assert.equal(host.counts().saves, 0);
});
test('blank and oversized rejection reasons stop before save', async () => {
  for (const reason of ['  ', 'x'.repeat(501)]) {
    const { host, api } = client(submitted);
    const report = await api.reject.runDetailed({ ...input, reason });
    assert.deepEqual(report.result, { ok: false, error: { kind: 'InvalidInput' } });
    assert(report.trace.length >= 2, 'load and the failing domain rule are observed');
    assert.equal(report.trace.at(-1)?.status, 'error');
    assert(report.trace.slice(0, -1).every(row => row.status === 'ok'));
    assert.equal(host.counts().saves, 0);
  }
});
test('NotFound stops before rules and save', async () => {
  const { host, api } = client(submitted);
  const report = await api.approve.runDetailed({ id: 'missing', expectedVersion: 2 });
  assert.deepEqual(report.result, { ok: false, error: { kind: 'NotFound' } });
  assert.deepEqual(report.trace.map(row => row.status), ['error']); assert.equal(host.counts().saves, 0);
});
test('save failure does not retry automatically and explicit retry can succeed', async () => {
  const { host, api } = client(submitted); host.unavailable(true);
  assert.deepEqual(await api.approve(input), { ok: false, error: { kind: 'SaveUnavailable' } });
  assert.deepEqual(host.counts(), { loads: 1, saves: 1, writes: 0 }); assert.deepEqual(host.row(), submitted);
  host.unavailable(false); assert((await api.approve(input)).ok);
  assert.deepEqual(host.counts(), { loads: 2, saves: 2, writes: 1 });
});
test('concurrent approvals have one winner under the supplied CAS', async () => {
  const { host, api } = client(submitted);
  const results = await Promise.all([api.approve(input), api.approve(input)]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.deepEqual(results.find(row => !row.ok), { ok: false, error: { kind: 'Conflict' } });
  assert.equal(host.counts().writes, 1); assert.equal(host.row().version, 3);
});
test('request fields cannot replace the trusted actor and host owns its actor copy', async () => {
  const identity = { ...employee }, host = createHost(submitted), api = createExpenses(host.ports(identity));
  identity.id = 'boss'; identity.role = 'manager';
  const injected = { ...input, actor: manager };
  assert.deepEqual(await api.approve(injected), { ok: false, error: { kind: 'Denied' } }); assert.equal(host.counts().saves, 0);
});
// Public contracts, not evidence that a learner used inference rather than annotations.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts() {
  const api = createExpenses(createHost(draft).ports(employee));
  const submit: Equal<Awaited<ReturnType<typeof api.submit>>, Result<Submitted, Failure>> = true;
  const approve: Equal<Awaited<ReturnType<typeof api.approve>>, Result<Approved, Failure>> = true;
  const reject: Equal<Awaited<ReturnType<typeof api.reject>>, Result<Rejected, Failure>> = true;
  // @ts-expect-error submit requires the chosen approver
  void api.submit({ id: 'e1', expectedVersion: 1 });
  // @ts-expect-error reject requires a reason
  void api.reject(input);
  // @ts-expect-error the version is part of every command input
  void api.approve({ id: 'e1' });
  void submit; void approve; void reject;
}
void contracts;
