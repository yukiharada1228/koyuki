/** @jsx ha */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Execution, Journal } from './comparison/kernel.js';
import { Backend } from './approval/backend.js';
import { Host } from './approval/host.js';
import { runDeclarative, runPlain } from './approval/runners.js';
import { singleApproval, extraApproval, decide, type Policy, type ApprovalEvent, type State, type ValidatedOrder } from './approval/domain.js';
import { OrderProcess, FulfillOrder, Parallel, Commit, Notify, ha } from './approval/declarative.js';
type Mode = 'declarative' | 'plain';
function fixture(mode: Mode, amount = 1000, policy: Policy = singleApproval) {
  const backend = new Backend(), execution = new Execution(new Journal()), host = new Host(backend, execution);
  host.start({ id: 'a', amount }, policy);
  const runner = mode === 'declarative' ? runDeclarative : runPlain;
  return { host, backend, execution, run: (h = host) => runner(h, 'a') };
}
function approval(host: Host, eventId = 'approve-1', decision: 'approve' | 'reject' = 'approve'): ApprovalEvent {
  const state = host.read('a').state;
  assert.equal(state.kind, 'waiting'); if (state.kind !== 'waiting') throw new Error('ExpectedWaiting');
  return { type: 'approval', eventId, orderId: 'a', requestId: state.requestId, stage: state.stage, actorRole: state.stage, decision };
}
for (const mode of ['declarative', 'plain'] as const) {
  test(`${mode}: small order completes without approval, repeated run does not repeat effects`, async () => {
    const f = fixture(mode); assert.deepEqual(await f.run(), { status: 'complete' });
    await f.run(); assert.deepEqual(f.backend.calls, ['commit:a', 'notify:a', 'ship:a']);
    assert.deepEqual(f.backend.deliveries, ['a']); assert.deepEqual(f.backend.shipments, ['a']);
  });
  test(`${mode}: high order pauses without IO, manager event resumes it`, async () => {
    const f = fixture(mode, 20_000);
    const first = await f.run(); assert.equal(first.status, 'waiting');
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.run(), first);
    assert.equal(f.backend.calls.length, 0);
    assert.deepEqual(f.host.receive(approval(f.host)), { ok: true, value: 'applied' });
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.backend.saved.get('a')?.approvals, ['manager']);
  });
  test(`${mode}: changing to double-approval policy adds finance stage with no runner changes`, async () => {
    const f = fixture(mode, 150_000, extraApproval);
    assert.equal((await f.run()).status, 'waiting');
    f.host.receive(approval(f.host, 'manager-yes'));
    const second = await f.run(); assert.equal(second.status, 'waiting');
    if (second.status === 'waiting') assert.equal(second.stage, 'finance');
    assert.equal(f.backend.calls.length, 0);
    f.host.receive(approval(f.host, 'finance-yes'));
    assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.backend.saved.get('a')?.approvals, ['manager', 'finance']);
  });
  test(`${mode}: manager and finance rejection both stop all external effects`, async () => {
    for (const atFinance of [false, true]) {
      const f = fixture(mode, 150_000, extraApproval); await f.run();
      if (atFinance) { f.host.receive(approval(f.host)); await f.run(); }
      f.host.receive(approval(f.host, 'reject', 'reject'));
      assert.deepEqual(await f.run(), { status: 'rejected', reason: atFinance ? 'FinanceRejected' : 'ManagerRejected' });
      assert.equal(f.backend.calls.length, 0);
    }
  });
  test(`${mode}: invalid input is a business rejection`, async () => {
    const f = fixture(mode, 0);
    assert.deepEqual(await f.run(), { status: 'rejected', reason: 'InvalidInput' }); assert.equal(f.backend.calls.length, 0);
  });
  test(`${mode}: save conflict never launches notification or shipment`, async () => {
    const f = fixture(mode); f.backend.saveConflict = true;
    const result = await f.run(); assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.deepEqual(result.failures, [{ slot: 'commit', category: 'business', message: 'SaveConflict' }]);
    assert.deepEqual(f.backend.calls, ['commit:a']); assert.equal(f.host.read('a').state.kind, 'ready');
  });
  test(`${mode}: mail-only infrastructure failure retries mail and reuses successful shipment`, async () => {
    const f = fixture(mode); f.backend.notifyFailure = 'infrastructure';
    const failed = await f.run(); assert.equal(failed.status, 'failed');
    assert.deepEqual(f.backend.shipments, ['a']); assert.equal(f.host.read('a').state.kind, 'committed');
    f.backend.notifyFailure = 'none';
    const resumed = new Host(f.backend, new Execution(f.execution.journal), f.host.store);
    assert.equal((await f.run(resumed)).status, 'complete');
    assert.equal(f.backend.calls.filter(x => x === 'ship:a').length, 1);
    assert.equal(f.backend.calls.filter(x => x === 'commit:a').length, 1);
    assert.equal(f.backend.calls.filter(x => x === 'notify:a').length, 2);
  });
  test(`${mode}: ship-only failure retries ship without resending mail`, async () => {
    const f = fixture(mode); f.backend.shipFailure = 'infrastructure';
    assert.equal((await f.run()).status, 'failed'); f.backend.shipFailure = 'none';
    assert.equal((await f.run()).status, 'complete');
    assert.equal(f.backend.calls.filter(x => x === 'notify:a').length, 1);
    assert.deepEqual(f.backend.deliveries, ['a']);
  });
  test(`${mode}: business rejection of one parallel child is cached and not retried implicitly`, async () => {
    const f = fixture(mode); f.backend.notifyFailure = 'business';
    const first = await f.run(); assert.equal(first.status, 'failed');
    f.backend.notifyFailure = 'none'; assert.deepEqual(await f.run(), first);
    assert.equal(f.backend.calls.filter(x => x === 'notify:a').length, 1);
    assert.deepEqual(f.backend.shipments, ['a']);
  });
  test(`${mode}: parallel starts both children and waits for slow sibling even after other failure`, async () => {
    const f = fixture(mode); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    f.backend.notifyFailure = 'infrastructure';
    f.backend.shipGate = async () => { entered(); await gate; };
    let finished = false;
    const pending = f.run().then(value => { finished = true; return value; });
    try {
      await started; await new Promise<void>(r => setImmediate(r));
      assert(f.backend.calls.includes('notify:a')); assert(f.backend.calls.includes('ship:a'));
      assert.equal(finished, false); assert.equal(f.host.read('a').state.kind, 'committed');
    } finally { release(); }
    assert.equal((await pending).status, 'failed'); assert.deepEqual(f.backend.shipments, ['a']);
  });
  test(`${mode}: concurrent pumps share journal claims and do not duplicate effects`, async () => {
    const f = fixture(mode);
    const other = new Host(f.backend, new Execution(f.execution.journal), f.host.store);
    const results = await Promise.all([f.run(), f.run(other)]);
    assert(results.every(result => result.status === 'complete'));
    assert.deepEqual(f.backend.calls, ['commit:a', 'notify:a', 'ship:a']);
  });
  test(`${mode}: approval event duplicates are idempotent, mismatched payload and stale request are rejected`, async () => {
    const f = fixture(mode, 150_000, extraApproval); await f.run();
    const event = approval(f.host);
    assert.deepEqual(f.host.receive(event), { ok: true, value: 'applied' });
    assert.deepEqual(f.host.receive(event), { ok: true, value: 'duplicate' });
    assert.deepEqual(f.host.receive({ ...event, decision: 'reject' }), { ok: false, error: 'EventIdentityMismatch' });
    assert.deepEqual(f.host.receive({ ...event, eventId: 'late-manager' }), { ok: false, error: 'WrongRequest' });
    await f.run(); assert.equal(f.host.read('a').state.kind, 'waiting');
  });
  test(`${mode}: wrong role or another request cannot advance approval`, async () => {
    const f = fixture(mode, 20_000); await f.run(); const event = approval(f.host);
    assert.deepEqual(f.host.receive({ ...event, actorRole: 'finance' }), { ok: false, error: 'WrongRole' });
    assert.deepEqual(f.host.receive({ ...event, requestId: 'another' }), { ok: false, error: 'WrongRequest' });
    assert.equal(f.host.read('a').state.kind, 'waiting'); assert.equal(f.backend.calls.length, 0);
  });
  test(`${mode}: starting policy is pinned, mutation/redeployment does not silently change pending case`, async () => {
    const policy = { ...singleApproval }, f = fixture(mode, 150_000, policy); await f.run();
    policy.financeFrom = 100_000;
    assert.throws(() => f.host.start({ id: 'a', amount: 150_000 }, policy), /StartIdentityMismatch/);
    f.host.receive(approval(f.host)); assert.equal((await f.run()).status, 'complete');
    assert.deepEqual(f.backend.saved.get('a')?.approvals, ['manager']);
  });
  test(`${mode}: crash after mail success retries with provider idempotency and preserves shipment success`, async () => {
    const f = fixture(mode);
    f.execution.afterExternal = name => { if (name.endsWith('notify.v1')) throw new Error('CrashAfterMail'); };
    assert.equal((await f.run()).status, 'failed');
    const resumed = new Host(f.backend, new Execution(f.execution.journal), f.host.store);
    assert.equal((await f.run(resumed)).status, 'complete');
    assert.deepEqual(f.backend.deliveries, ['a']); assert.deepEqual(f.backend.shipments, ['a']);
  });
}

test('declarative description is pure and serializable, exposes waiting and parallel children without executing', () => {
  const f = fixture('declarative', 20_000);
  const before = f.host.read('a');
  assert.deepEqual(OrderProcess({ state: before.state }), { kind: 'advance' });
  assert.deepEqual(f.host.read('a'), before); assert.equal(f.backend.calls.length, 0);
  const saved = { kind: 'saved-order' as const, id: 'a', amount: 1000, approvals: [], receipt: 'r' };
  const plan = <FulfillOrder order={saved} />;
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.equal(plan.kind, 'parallel');
  if (plan.kind === 'parallel') assert.deepEqual(plan.children.map(c => c.operation), ['notify', 'ship']);
});
test('JSX composition limitation: invalid and duplicate parallel children are detected at runtime', () => {
  assert.throws(() => Parallel({ children: [{ kind: 'wait', stage: 'manager', requestId: 'x' }] }), /ParallelRequiresEffects/);
  const saved = { kind: 'saved-order' as const, id: 'a', amount: 1000, approvals: [], receipt: 'r' };
  const node = Notify({ input: saved }); assert.throws(() => Parallel({ children: [node, node] }), /DuplicateChildIdentity/);
});
test('revision guard rejects stale internal state update after approval event', async () => {
  const f = fixture('declarative', 20_000); await f.run(); const old = f.host.read('a');
  f.host.receive(approval(f.host));
  assert.equal(f.host.apply('a', old.revision, { type: 'advance' }), false);
  assert.equal(f.host.read('a').state.kind, 'ready');
});
test('pure transition rejects saved data from another order', () => {
  const ready: State = { kind: 'ready', order: { kind: 'approved-order', id: 'a', amount: 1, approvals: [] } };
  assert.deepEqual(decide(ready, { type: 'saved', order: { kind: 'saved-order', id: 'b', amount: 1, approvals: [], receipt: 'r' } }, singleApproval), { ok: false, error: 'InvalidSavedOrder' });
});
function typeAssertions(validated: ValidatedOrder) {
  // @ts-expect-error An order without approval cannot be committed.
  const badCommit = <Commit input={validated} />;
  // @ts-expect-error A notification requires a saved receipt, not just approval.
  const badNotification = <Notify input={{ kind: 'approved-order', id: 'a', amount: 1, approvals: [] }} />;
  return [badCommit, badNotification];
}
void typeAssertions;

test('both implementations have identical state/outcome/effect snapshots across approval, partial failure and retry', async () => {
  const a = fixture('declarative', 150_000, extraApproval), b = fixture('plain', 150_000, extraApproval);
  const compare = async () => {
    assert.deepEqual(await a.run(), await b.run());
    assert.deepEqual(a.host.read('a'), b.host.read('a'));
    assert.deepEqual(a.backend.calls, b.backend.calls);
    assert.deepEqual(a.backend.deliveries, b.backend.deliveries);
    assert.deepEqual(a.backend.shipments, b.backend.shipments);
  };
  await compare();
  a.host.receive(approval(a.host, 'manager')); b.host.receive(approval(b.host, 'manager'));
  await compare();
  a.backend.notifyFailure = b.backend.notifyFailure = 'infrastructure';
  a.host.receive(approval(a.host, 'finance')); b.host.receive(approval(b.host, 'finance'));
  await compare();
  a.backend.notifyFailure = b.backend.notifyFailure = 'none'; await compare();
});
for (const mode of ['declarative', 'plain'] as const) test(`${mode}: approval thresholds have inclusive boundaries`, async () => {
  for (const [amount, expected] of [[9999, 'complete'], [10000, 'manager'], [99999, 'manager'], [100000, 'finance']] as const) {
    const f = fixture(mode, amount, extraApproval); const first = await f.run();
    if (expected === 'complete') { assert.equal(first.status, 'complete'); continue; }
    assert.equal(first.status, 'waiting'); f.host.receive(approval(f.host));
    const next = await f.run();
    assert.equal(next.status, expected === 'finance' ? 'waiting' : 'complete');
    if (next.status === 'waiting') assert.equal(next.stage, 'finance');
  }
});
test('REMAINING MODEL LIMIT: a structurally fabricated approved state can bypass policy if adapter is called directly', async () => {
  const backend = new Backend();
  const result = await backend.commit.run({ kind: 'approved-order', id: 'fabricated', amount: 150_000, approvals: [] }, { idempotencyKey: 'fabricated' });
  assert(result.ok); assert.equal(backend.saved.size, 1);
  // Normal host transitions prevent this, but public structural types aren't approval proofs.
});
