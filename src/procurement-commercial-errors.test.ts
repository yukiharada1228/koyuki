import test from 'node:test';
import assert from 'node:assert/strict';
import { err, type Result } from './framework/index.js';
import * as domain from './experiments/procurement/domain.js';
import { procurement, procurementChanges } from './experiments/procurement/application.js';
import { plainProcurement, plainWithCommit } from './experiments/procurement/plain.js';
import { helperProcurement, helperWithCommit } from './experiments/procurement/helper.js';
import { baselineDetail } from './experiments/procurement/baseline-detail.js';
import { baselineReplay } from './experiments/procurement/baseline-replay.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { actor, policy } from './experiments/procurement/comparison-scenario.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Fn = (...args: never[]) => unknown;
type Failure<R> = R extends { result: infer V } ? Failure<V> : R extends { ok: false; error: infer E } ? E : never;
type Kind<E> = E extends { kind: infer K } ? K : never;
type ErrorKind<F> = F extends Fn ? Kind<Failure<Awaited<ReturnType<F>>>> : never;
type Common = 'Denied' | 'TargetMismatch' | 'InvalidInput' | 'Conflict';
type Loaded = Common | 'NotFound' | 'WrongState';
type Expected = {
  'requests.create': 'Denied' | 'InvalidInput' | 'Conflict' | 'NotFound';
  'requests.edit': Loaded;
  'requests.submit': Loaded | 'BudgetExceeded';
  'requests.approve': Loaded;
  'requests.withdraw': Loaded;
  'requests.reject': Loaded;
  'requests.return': Loaded;
  'requests.reassign': Loaded;
  'orders.place': Loaded | 'AlreadyExists';
  'orders.amend': Loaded;
  'orders.cancel': Loaded;
  'orders.complete': Loaded | 'InvoiceMismatch';
};
type Flatten<T> = T extends { requests: infer R; orders: infer O }
  ? { [K in keyof R as `requests.${K & string}`]: R[K] } & { [K in keyof O as `orders.${K & string}`]: O[K] } : never;
type Call<C> = C extends Fn ? C : C extends { run: infer F } ? F : never;
type Detail<C> = C extends { runDetailed: infer F } ? F : never;
type Kinds<T, D = false, F = Flatten<T>> = { [K in keyof Expected]: K extends keyof F ? ErrorKind<D extends true ? Detail<F[K]> : Call<F[K]>> : never };
type ReplayOnly = 'InvalidReplayRequest' | 'ReplayMismatch' | 'CommitUnknown' | 'ReplayInputNotCloneable';
type Replayed = { [K in keyof Expected]: Expected[K] | ReplayOnly };

function publicContracts(repository: SqliteProcurement) {
  const identity = actor('buyer');
  const normal = procurement(repository, identity, policy), changed = procurementChanges(repository, identity, policy);
  const plain = plainProcurement(repository, identity, policy), helper = helperProcurement(repository, identity, policy);
  const plainDetail = baselineDetail(plainProcurement, repository, identity, policy), helperDetail = baselineDetail(helperProcurement, repository, identity, policy);
  const replay = procurementReplay(repository, identity, policy), plainReplay = baselineReplay('plain', repository, identity, policy), helperReplay = baselineReplay('helper', repository, identity, policy);
  type Public = [Assert<Equal<Kinds<typeof normal>, Expected>>, Assert<Equal<Kinds<typeof changed>, Expected>>, Assert<Equal<Kinds<typeof plain>, Expected>>, Assert<Equal<Kinds<typeof helper>, Expected>>];
  type Detailed = [Assert<Equal<Kinds<typeof normal, true>, Expected>>, Assert<Equal<Kinds<typeof plainDetail, true>, Expected>>, Assert<Equal<Kinds<typeof helperDetail, true>, Expected>>];
  type Replay = [Assert<Equal<Kinds<typeof replay>, Replayed>>, Assert<Equal<Kinds<typeof plainReplay>, Replayed>>, Assert<Equal<Kinds<typeof helperReplay>, Replayed>>,
    Assert<Equal<Kinds<typeof replay, true>, Replayed>>, Assert<Equal<Kinds<typeof plainReplay, true>, Replayed>>, Assert<Equal<Kinds<typeof helperReplay, true>, Replayed>>];
  async function refusedBranches() {
    const created = await normal.requests.create({ id: 'request', lines: [] });
    if (!created.ok) {
      // @ts-expect-error A creation cannot fail an approval budget rule.
      if (created.error.kind === 'BudgetExceeded') throw Error('unreachable');
    }
    const completed = await normal.orders.complete({ id: 'order', expectedVersion: 1 });
    if (!completed.ok) {
      // @ts-expect-error Completion cannot register another order.
      if (completed.error.kind === 'AlreadyExists') throw Error('unreachable');
    }
  }
  void refusedBranches;
}
void publicContracts;

type GuardContracts = [
  Assert<Equal<ErrorKind<typeof domain.parseRequestLines>, 'InvalidInput'>>,
  Assert<Equal<ErrorKind<typeof domain.checkRequestCreation>, 'Denied' | 'InvalidInput'>>,
  Assert<Equal<ErrorKind<typeof domain.checkBuyerRequest>, Common>>,
  Assert<Equal<ErrorKind<typeof domain.checkApproverRequest>, Common>>,
  Assert<Equal<ErrorKind<typeof domain.checkRequestEdit>, 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.submitCheckedRequest>, 'WrongState' | 'InvalidInput' | 'BudgetExceeded'>>,
  Assert<Equal<ErrorKind<typeof domain.approveCheckedRequest>, 'WrongState' | 'Denied'>>,
  Assert<Equal<ErrorKind<typeof domain.withdrawCheckedRequest>, 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.rejectCheckedRequest>, 'WrongState' | 'InvalidInput'>>,
  Assert<Equal<ErrorKind<typeof domain.returnCheckedRequest>, 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.reassignCheckedRequest>, 'WrongState' | 'InvalidInput'>>,
  Assert<Equal<ErrorKind<typeof domain.checkOrder>, Common | 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.placeCheckedOrder>, 'WrongState' | 'InvalidInput' | 'AlreadyExists'>>,
  Assert<Equal<ErrorKind<typeof domain.amendCheckedOrder>, 'WrongState' | 'InvalidInput'>>,
  Assert<Equal<ErrorKind<typeof domain.cancelCheckedOrder>, 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.completeCheckedOrder>, 'InvoiceMismatch'>>,
];

test('line parsing and creation checks infer their failures without a declared error union', () => {
  assert.deepEqual(domain.parseRequestLines([]), err({ kind: 'InvalidInput' }));
  assert.deepEqual(domain.checkRequestCreation({ actor: { ...actor('buyer'), active: false }, input: { id: '', lines: [] } }), err({ kind: 'Denied' }));
  assert.deepEqual(domain.checkRequestCreation({ actor: actor('buyer'), input: { id: '', lines: [] } }), err({ kind: 'InvalidInput' }));
});

test('all three ordinary implementations retain a custom commit payload in creation', async () => {
  const failed = err({ kind: 'StoreUnavailable' as const, retryAfter: 30 });
  for (const factory of [procurement, plainWithCommit, helperWithCommit]) {
    const memory = new MemoryProcurement(); let commits = 0;
    const repository: ProcurementRepository<{ kind: 'StoreUnavailable'; retryAfter: number }> = {
      read: memory.read.bind(memory), related: memory.related.bind(memory),
      commit: async () => { commits++; return failed; },
    };
    const app = factory(repository, actor('buyer'), policy);
    const result = await app.requests.create({ id: 'request', lines: [{ sku: 'sku', quantity: 1, unitCents: 100 }] });
    assert.deepEqual(result, failed); assert.equal(commits, 1);
    if (!result.ok && result.error.kind === 'StoreUnavailable') { const seconds: number = result.error.retryAfter; assert.equal(seconds, 30); }
    assert.deepEqual(memory.list('request', actor('buyer')), []);
  }
});
