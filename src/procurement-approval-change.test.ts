import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Result } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { baselineReplay } from './experiments/procurement/baseline-replay.js';
import { restoreEntity, type Actor, type Request, type Policy, type FirstReview, type FinalReview, type Approved } from './experiments/procurement/domain.js';
import type { StudyFactory } from './experiments/procurement/comparison-contract.js';
const factories = { koyuki: procurement, plain: plainProcurement, helper: helperProcurement } satisfies Record<string, StudyFactory>;
const actor = (id: string, role: Actor['role'] = id === 'buyer' ? 'buyer' : 'approver'): Actor => ({ id, role, groupId: 'g1', active: true });
const policy: Policy = { requestLimitCents: 2000, approverIds: ['first', 'final', 'other'], secondApproval: { aboveCents: 1000, approverId: 'final' } };
const input = (id: string, cents = 1001) => ({ id, lines: [{ sku: 'a', quantity: 1, unitCents: cents }] });
function success<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
function store(backend: 'memory' | 'sqlite') {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-approval-change-'));
  let repository: MemoryProcurement | SqliteProcurement = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(join(directory, 'study.sqlite'), 'g1');
  return { get repository() { return repository; }, reopen() {
    if (repository instanceof SqliteProcurement) { repository.close(); repository = new SqliteProcurement(join(directory, 'study.sqlite'), 'g1'); }
  }, close() { if (repository instanceof SqliteProcurement) repository.close(); rmSync(directory, { recursive: true, force: true }); } };
}
for (const backend of ['memory', 'sqlite'] as const) for (const [name, factory] of Object.entries(factories)) {
  test(`two-stage specification change / ${name} / ${backend}`, async () => {
    const disk = store(backend);
    const commands = (id: string) => factory(disk.repository, actor(id), policy);
    const state = () => success(disk.repository.read('request', 'high', actor('buyer')));
    try {
      const mutablePolicy = { requestLimitCents: 2000, approverIds: ['first', 'final', 'other'], secondApproval: { aboveCents: 1000, approverId: 'final' } };
      const buyer = factory(disk.repository, actor('buyer'), mutablePolicy);
      // Construction owns its configuration; changing the host object cannot change this submission.
      mutablePolicy.secondApproval.aboveCents = 2000; mutablePolicy.secondApproval.approverId = 'other';
      success(await buyer.requests.create(input('high')));
      const first = success(await buyer.requests.submit({ id: 'high', expectedVersion: 1, approverId: 'first' }));
      assert.equal(first.state, 'first-review'); assert.equal(first.version, 2);
      assert(first.state === 'first-review'); assert.equal(first.finalApproverId, 'final');
      assert.deepEqual(restoreEntity(JSON.parse(JSON.stringify(first))), first);
      disk.reopen();
      assert.deepEqual(await commands('final').requests.approve({ id: 'high', expectedVersion: 2 }), { ok: false, error: { kind: 'Denied' } });
      assert.deepEqual(await commands('buyer').orders.place({ id: 'high', expectedVersion: 2, orderId: 'early', supplier: 's' }), { ok: false, error: { kind: 'WrongState' } });
      assert.deepEqual(state(), first);
      const reviewed = success(await commands('first').requests.approve({ id: 'high', expectedVersion: 2 }));
      assert(reviewed.state === 'final-review'); assert.equal(reviewed.firstApprovedBy, 'first'); assert.equal(reviewed.approverId, 'final'); assert.equal(reviewed.version, 3);
      assert(!Object.hasOwn(reviewed, 'finalApproverId')); assert.deepEqual(restoreEntity(JSON.parse(JSON.stringify(reviewed))), reviewed);
      disk.reopen();
      // Policy changes after submission do not rewrite the persisted approval route.
      const changed = factory(disk.repository, actor('final'), { ...policy, secondApproval: { aboveCents: 0, approverId: 'other' } });
      assert.deepEqual(await commands('first').requests.approve({ id: 'high', expectedVersion: 3 }), { ok: false, error: { kind: 'Denied' } });
      assert.deepEqual(await commands('final').requests.approve({ id: 'high', expectedVersion: 2 }), { ok: false, error: { kind: 'Conflict' } });
      assert.deepEqual(await commands('buyer').orders.place({ id: 'high', expectedVersion: 3, orderId: 'early', supplier: 's' }), { ok: false, error: { kind: 'WrongState' } });
      assert.deepEqual(state(), reviewed);
      const approved = success(await changed.requests.approve({ id: 'high', expectedVersion: 3 }));
      assert(approved.state === 'approved' && approved.approval === 'dual');
      assert.equal(approved.firstApprovedBy, 'first'); assert.equal(approved.approvedBy, 'final'); assert.equal(approved.version, 4);
      assert.deepEqual(restoreEntity(JSON.parse(JSON.stringify(approved))), approved);
      disk.reopen(); assert.deepEqual(state(), approved);
      success(await commands('buyer').orders.place({ id: 'high', expectedVersion: 4, orderId: 'po', supplier: 's' }));
      for (const cents of [999, 1000]) {
        const id = `low-${cents}`;
        success(await commands('buyer').requests.create(input(id, cents)));
        const submitted = success(await commands('buyer').requests.submit({ id, expectedVersion: 1, approverId: 'first' }));
        assert.equal(submitted.state, 'submitted');
        const result = success(await commands('first').requests.approve({ id, expectedVersion: 2 }));
        assert(result.state === 'approved'); assert.equal(result.approvedBy, 'first'); assert.equal(result.version, 3); assert(!Object.hasOwn(result, 'approval'));
      }
      success(await commands('buyer').requests.create(input('over-cap', 2001)));
      assert.deepEqual(await commands('buyer').requests.submit({ id: 'over-cap', expectedVersion: 1, approverId: 'first' }), { ok: false, error: { kind: 'BudgetExceeded' } });
      assert.equal(success(disk.repository.read('request', 'over-cap', actor('buyer'))).version, 1);
    } finally { disk.close(); }
  });
  test(`recovery and separation of duties / ${name} / ${backend}`, async () => {
    const disk = store(backend), commands = (id: string) => factory(disk.repository, actor(id), policy);
    try {
      for (const phase of ['first-review', 'final-review'] as const) for (const operation of ['withdraw', 'return', 'reject', 'reassign'] as const) {
        const id = `${phase}-${operation}`;
        success(await commands('buyer').requests.create(input(id)));
        success(await commands('buyer').requests.submit({ id, expectedVersion: 1, approverId: 'first' }));
        if (phase === 'final-review') success(await commands('first').requests.approve({ id, expectedVersion: 2 }));
        const expectedVersion = phase === 'first-review' ? 2 : 3, currentApprover = phase === 'first-review' ? 'first' : 'final';
        assert.deepEqual(await commands('other').requests.return({ id, expectedVersion }), { ok: false, error: { kind: 'Denied' } });
        if (operation === 'reassign') {
          const invalid = phase === 'first-review' ? 'final' : 'first';
          assert.deepEqual(await commands(currentApprover).requests.reassign({ id, expectedVersion, approverId: invalid }), { ok: false, error: { kind: 'InvalidInput' } });
          const reassigned = success(await commands(currentApprover).requests.reassign({ id, expectedVersion, approverId: 'other' }));
          assert.equal(reassigned.state, phase);
          assert(reassigned.state === 'first-review' || reassigned.state === 'final-review'); assert.equal(reassigned.approverId, 'other');
          const next = success(await commands('other').requests.approve({ id, expectedVersion: expectedVersion + 1 }));
          assert.equal(next.state, phase === 'first-review' ? 'final-review' : 'approved');
        } else {
          const result = operation === 'withdraw' ? await commands('buyer').requests.withdraw({ id, expectedVersion })
            : operation === 'return' ? await commands(currentApprover).requests.return({ id, expectedVersion })
              : await commands(currentApprover).requests.reject({ id, expectedVersion, reason: 'revise' });
          const reset = success(result); assert.equal(reset.state, operation === 'reject' ? 'rejected' : 'draft');
          assert(!Object.hasOwn(reset, 'firstApprovedBy')); assert(!Object.hasOwn(reset, 'finalApproverId'));
          assert.deepEqual(restoreEntity(JSON.parse(JSON.stringify(reset))), reset);
          if (operation !== 'reject') {
            const restarted = success(await commands('buyer').requests.submit({ id, expectedVersion: expectedVersion + 1, approverId: 'first' }));
            assert.equal(restarted.state, 'first-review');
          }
        }
      }
    } finally { disk.close(); }
  });
}
for (const name of ['koyuki', 'plain', 'helper'] as const) test(`approval receipts survive restart / ${name}`, async () => {
  const disk = store('sqlite');
  const commands = (id: string) => {
    assert(disk.repository instanceof SqliteProcurement);
    return name === 'koyuki' ? procurementReplay(disk.repository, actor(id), policy) : baselineReplay(name, disk.repository, actor(id), policy);
  };
  try {
    success(await commands('buyer').requests.create.run({ requestId: 'create', input: input('rq') }));
    success(await commands('buyer').requests.submit.run({ requestId: 'submit', input: { id: 'rq', expectedVersion: 1, approverId: 'first' } }));
    const call = { requestId: 'first-approval', input: { id: 'rq', expectedVersion: 2 } };
    const concurrent = await Promise.all([commands('first').requests.approve.run(call), commands('first').requests.approve.run(call)]);
    const executions = concurrent.map(success); assert.equal(executions.filter(value => value.kind === 'committed').length, 1);
    assert.equal(executions.filter(value => value.kind === 'replayed').length, 1);
    const first = executions[0]!; assert.equal(first.value.result.state, 'final-review');
    assert.deepEqual(executions[1]!.value, first.value);
    disk.reopen();
    const final = success(await commands('final').requests.approve.run({ requestId: 'final-approval', input: { id: 'rq', expectedVersion: 3 } }));
    assert.equal(final.value.result.state, 'approved'); disk.reopen();
    const old = success(await commands('first').requests.approve.run(call)); assert.equal(old.kind, 'replayed'); assert.deepEqual(old.value, first.value);
    assert.equal(success(disk.repository.read('request', 'rq', actor('buyer'))).version, 4);
    assert.equal(success(disk.repository.read('request', 'rq', actor('buyer'))).state, 'approved');
  } finally { disk.close(); }
});
test('restore rejects missing or forged approval evidence and conflicting state payloads', async () => {
  const repository = new MemoryProcurement(), buyer = procurement(repository, actor('buyer'), policy);
  success(await buyer.requests.create(input('rq')));
  const first = success(await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'first' })); assert(first.state === 'first-review');
  const final = success(await procurement(repository, actor('first'), policy).requests.approve({ id: 'rq', expectedVersion: 2 })); assert(final.state === 'final-review');
  const approved = success(await procurement(repository, actor('final'), policy).requests.approve({ id: 'rq', expectedVersion: 3 })); assert(approved.state === 'approved');
  const { finalApproverId, ...missingFinal } = first;
  const { firstApprovedBy, ...missingProof } = final;
  const { firstApprovedBy: approvedProof, ...missingApprovedProof } = approved;
  for (const malformed of [missingFinal, missingProof, missingApprovedProof, { ...first, version: 1 }, { ...final, version: 2 }, { ...approved, version: 3 }, { ...first, finalApproverId: 'first' }, { ...first, finalApproverId: 'buyer' },
    { ...final, firstApprovedBy: 'final' }, { ...final, firstApprovedBy: 'buyer' }, { ...final, finalApproverId: 'final' },
    { ...approved, firstApprovedBy: 'final' }, { ...approved, approvedBy: 'first' }, { ...approved, approval: 'single' }]) assert.equal(restoreEntity(malformed), null);
});
function typeContracts(first: FirstReview, final: FinalReview, approved: Approved) {
  // @ts-expect-error an intermediate approval is not a completed approval
  const invalid: Approved = final;
  // @ts-expect-error a first review cannot carry final approval evidence
  const missing: FinalReview = first;
  const request: Request = final; void invalid; void missing; void request;
  if (approved.approval === 'dual') { const firstApprover: string = approved.firstApprovedBy; void firstApprover; }
}
void typeContracts;

for (const [name, factory] of Object.entries(factories)) test(`invalid second-approval policies cannot submit / ${name}`, async () => {
  const repository = new MemoryProcurement();
  success(await factory(repository, actor('buyer'), policy).requests.create(input('rq')));
  const before = repository.commits;
  for (const secondApproval of [
    { aboveCents: -1, approverId: 'final' }, { aboveCents: 0.5, approverId: 'final' },
    { aboveCents: NaN, approverId: 'final' }, { aboveCents: Infinity, approverId: 'final' },
    { aboveCents: 0, approverId: 'first' }, { aboveCents: 0, approverId: 'buyer' },
    { aboveCents: 0, approverId: 'missing' }, { aboveCents: 0, approverId: ' final ' },
  ]) {
    const buyer = factory(repository, actor('buyer'), { ...policy, secondApproval });
    assert.deepEqual(await buyer.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'first' }), { ok: false, error: { kind: 'InvalidInput' } });
    assert.equal(repository.commits, before);
  }
});
