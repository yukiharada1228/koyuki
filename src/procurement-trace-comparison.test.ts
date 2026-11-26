import test from 'node:test';
import assert from 'node:assert/strict';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { baselineDetail } from './experiments/procurement/baseline-detail.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import type { Actor, Approved, FinalReview } from './experiments/procurement/domain.js';
const actor: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }] };
const builders = {
  koyuki: (repository: ProcurementRepository) => procurement(repository, actor, policy),
  plain: (repository: ProcurementRepository) => baselineDetail(plainProcurement, repository, actor, policy),
  helper: (repository: ProcurementRepository) => baselineDetail(helperProcurement, repository, actor, policy),
};
type Builder = typeof builders[keyof typeof builders];
async function reports(build: Builder) {
  const repository = new MemoryProcurement(), commands = build(repository);
  const success = await commands.requests.create.runDetailed(input);
  const loadFailure = await commands.requests.approve.runDetailed({ id: 'missing', expectedVersion: 1 });
  const ruleFailure = await commands.requests.edit.runDetailed({ id: 'rq', expectedVersion: 1, lines: [] });
  const saveFailure = await commands.requests.create.runDetailed(input);
  assert.deepEqual(success.trace.map(entry => entry.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(loadFailure.trace.map(entry => entry.status), ['error']); assert.equal(loadFailure.plan, null);
  assert.deepEqual(ruleFailure.trace.map(entry => entry.status), ['ok', 'ok', 'ok', 'error']); assert.equal(ruleFailure.plan, null);
  assert.deepEqual(saveFailure.trace.map(entry => entry.status), ['ok', 'ok', 'ok', 'ok', 'error']); assert.notEqual(saveFailure.plan, null);
  assert.deepEqual(saveFailure.result, { ok: false, error: { kind: 'Conflict' } });
  assert.equal(repository.commits, 1);
  return { success, loadFailure, ruleFailure, saveFailure };
}
for (const [name, build] of Object.entries(builders)) {
  test(`diagnostic parity for success and load/rule/save failures: ${name}`, async () => {
    assert.deepEqual(await reports(build), await reports(builders.koyuki));
  });
  test(`unexpected adapter exceptions remain defects without a fabricated successful report: ${name}`, async () => {
    const memory = new MemoryProcurement();
    const broken: ProcurementRepository = { read: memory.read.bind(memory), related: memory.related.bind(memory), commit: async () => { throw new Error('InjectedCommitFailure'); } };
    await assert.rejects(build(broken).requests.create.runDetailed(input), /InjectedCommitFailure/);
    assert.equal(memory.commits, 0);
    const brokenLoad: ProcurementRepository = { ...broken, read: async () => { throw new Error('InjectedLoadFailure'); } };
    await assert.rejects(build(brokenLoad).requests.approve.runDetailed({ id: 'rq', expectedVersion: 1 }), /InjectedLoadFailure/);
  });
  test(`simultaneous calls own their trace and plan: ${name}`, async () => {
    const memory = new MemoryProcurement(), commands = build(memory);
    const calls = [{ ...input, id: 'a' }, { ...input, id: 'b' }];
    const actual = await Promise.all(calls.map(call => commands.requests.create.runDetailed(call)));
    const expectedCommands = builders.koyuki(new MemoryProcurement());
    const expected = await Promise.all(calls.map(call => expectedCommands.requests.create.runDetailed(call)));
    assert.deepEqual(actual, expected); assert.equal(memory.commits, 2);
  });
}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Success<R> = R extends { ok: true; value: infer T } ? T : never;
const detailed = builders.helper(new MemoryProcurement());
const exact: Equal<Success<Awaited<ReturnType<typeof detailed.requests.approve.run>>>, Approved | FinalReview> = true;
void exact;
if (false) {
  // @ts-expect-error diagnostic wrapping retains each operation's input contract
  detailed.receipts.receive.runDetailed({ id: 'po', expectedVersion: 1, receiptId: 'rc' });
}
