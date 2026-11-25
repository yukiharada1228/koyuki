import { actor, policy, story } from './experiments/procurement/comparison-scenario.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { StudyFactory } from './experiments/procurement/comparison-contract.js';
import type { Approved, FinalReview } from './experiments/procurement/domain.js';
const factories = { koyuki: procurement, plain: plainProcurement, helper: helperProcurement } satisfies Record<string, StudyFactory>;
for (const backend of ['memory', 'sqlite'] as const) for (const [name, factory] of Object.entries(factories)) {
  test(`25-operation parity: ${name} / ${backend}`, async () => {
    const expected = await story(procurement, new MemoryProcurement());
    const directory = backend === 'sqlite' ? mkdtempSync(join(tmpdir(), 'koyuki-comparison-')) : null;
    const repository = directory ? new SqliteProcurement(join(directory, 'study.sqlite'), 'g1') : new MemoryProcurement();
    try { assert.deepEqual(await story(factory, repository), expected); }
    finally { if (repository instanceof SqliteProcurement) repository.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  });
}
test('all three orchestration styles stop failed loads and rules before saving', async () => {
  for (const factory of Object.values(factories)) {
    const repository = new MemoryProcurement(), buyer = factory(repository, actor('buyer'), policy);
    assert.deepEqual(await buyer.requests.create({ id: 'bad', lines: [] }), { ok: false, error: { kind: 'InvalidInput' } });
    assert.deepEqual(await buyer.requests.approve({ id: 'missing', expectedVersion: 1 }), { ok: false, error: { kind: 'NotFound' } });
    assert.equal(repository.commits, 0);
    assert((await buyer.requests.create({ id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 1000 }] })).ok);
    const before = repository.commits;
    const denied = factory(repository, actor('buyer', 'other'), policy);
    assert.deepEqual(await denied.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), { ok: false, error: { kind: 'Denied' } });
    const changedPolicy = factory(repository, actor('buyer'), { ...policy, requestLimitCents: 999 });
    assert.deepEqual(await changedPolicy.requests.submit({ id: 'rq', expectedVersion: 1, approverId: 'approver' }), { ok: false, error: { kind: 'BudgetExceeded' } });
    assert.equal(repository.commits, before);
  }
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const koyuki = procurement(new MemoryProcurement(), actor('approver'), policy);
const plain = plainProcurement(new MemoryProcurement(), actor('approver'), policy);
const helper = helperProcurement(new MemoryProcurement(), actor('approver'), policy);
type Success<R> = R extends { ok: true; value: infer T } ? T : never;
const koyukiExact: Equal<Success<Awaited<ReturnType<typeof koyuki.requests.approve>>>, Approved | FinalReview> = true;
const plainExact: Equal<Success<Awaited<ReturnType<typeof plain.requests.approve>>>, Approved | FinalReview> = true;
const helperExact: Equal<Success<Awaited<ReturnType<typeof helper.requests.approve>>>, Approved | FinalReview> = true;
void koyukiExact; void plainExact; void helperExact;
if (false) {
  // @ts-expect-error plain TypeScript preserves the operation's required fields
  plain.requests.submit({ id: 'rq', expectedVersion: 1 });
  // @ts-expect-error the helper preserves the operation's required fields too
  helper.inventory.move({ id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'receiving', quantity: 1 });
}
