import test from 'node:test';
import assert from 'node:assert/strict';
import { err, type Result } from './framework/index.js';
import * as domain from './experiments/procurement/domain.js';
import * as inventory from './experiments/procurement/inventory.js';
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
type Loaded = Common | 'NotFound';
type Expected = {
  'receipts.receive': Loaded | 'WrongState' | 'QuantityExceeded' | 'InsufficientStock';
  'receipts.return': Loaded | 'WrongState' | 'InsufficientStock';
  'receipts.correct': Loaded | 'WrongState' | 'QuantityExceeded' | 'InsufficientStock';
  'inventory.reserve': Loaded | 'InsufficientStock';
  'inventory.release': Loaded | 'InsufficientStock';
  'inventory.move': Loaded | 'InsufficientStock';
  'inventory.adjust': Loaded | 'InsufficientStock';
};
type Flatten<T> = T extends { receipts: infer R; inventory: infer S }
  ? { [K in keyof R as `receipts.${K & string}`]: R[K] } & { [K in keyof S as `inventory.${K & string}`]: S[K] } : never;
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
    const reserved = await normal.inventory.reserve({ id: 'warehouse', expectedVersion: 0, sku: 'a', location: 'receiving', quantity: 1 });
    if (!reserved.ok) {
      // @ts-expect-error Inventory operations do not have a receipt state transition.
      if (reserved.error.kind === 'WrongState') throw Error('unreachable');
    }
    const returned = await normal.receipts.return({ id: 'receipt', expectedVersion: 1, reason: 'damaged' });
    if (!returned.ok) {
      // @ts-expect-error Returning a receipt does not increase an order's received quantity.
      if (returned.error.kind === 'QuantityExceeded') throw Error('unreachable');
    }
  }
  void refusedBranches;
}
void publicContracts;

type StockErrors = 'InvalidInput' | 'TargetMismatch' | 'InsufficientStock';
type GuardContracts = [
  Assert<Equal<ErrorKind<typeof domain.receiveOrder>, Common | 'WrongState' | 'QuantityExceeded'>>,
  Assert<Equal<ErrorKind<typeof domain.checkReceipt>, Common | 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.returnCheckedReceipt>, 'InvalidInput'>>,
  Assert<Equal<ErrorKind<typeof domain.returnReceipt>, Common | 'WrongState'>>,
  Assert<Equal<ErrorKind<typeof domain.correctCheckedReceipt>, Common | 'WrongState' | 'QuantityExceeded'>>,
  Assert<Equal<ErrorKind<typeof domain.correctReceipt>, Common | 'WrongState' | 'QuantityExceeded'>>,
  Assert<Equal<ErrorKind<typeof inventory.checkStock>, Common>>,
  Assert<Equal<ErrorKind<typeof inventory.reserveCheckedStock>, 'InvalidInput' | 'InsufficientStock'>>,
  Assert<Equal<ErrorKind<typeof inventory.releaseCheckedStock>, 'InvalidInput' | 'InsufficientStock'>>,
  Assert<Equal<ErrorKind<typeof inventory.moveCheckedStock>, 'InvalidInput' | 'InsufficientStock'>>,
  Assert<Equal<ErrorKind<typeof inventory.adjustCheckedStock>, 'InvalidInput' | 'InsufficientStock'>>,
  Assert<Equal<ErrorKind<typeof inventory.includeReceivedStock>, StockErrors>>,
  Assert<Equal<ErrorKind<typeof inventory.includeChangedStock>, StockErrors>>,
  Assert<Equal<ErrorKind<typeof inventory.receiveIntoStock>, Common | 'WrongState' | 'QuantityExceeded' | 'InsufficientStock'>>,
  Assert<Equal<ErrorKind<typeof inventory.returnFromStock>, Common | 'WrongState' | 'InsufficientStock'>>,
  Assert<Equal<ErrorKind<typeof inventory.correctInStock>, Common | 'WrongState' | 'QuantityExceeded' | 'InsufficientStock'>>,
];

test('the stock guard preserves private context while inferring only its four failures', () => {
  class Token { #value = 3; read() { return this.#value; } }
  const token = new Token(), context = { input: { id: 'warehouse', expectedVersion: 0, sku: 'a', location: 'receiving', quantity: 1 }, actor: actor('warehouse'), stock: null, token };
  const checked = inventory.checkStock(context); assert(checked.ok);
  assert.strictEqual(checked.value, context); assert.strictEqual(checked.value.token, token); assert.equal(checked.value.token.read(), 3);
  assert.deepEqual(inventory.checkStock({ ...context, actor: { ...context.actor, active: false }, input: { ...context.input, id: 'wrong' } }), err({ kind: 'Denied' }));
  assert.deepEqual(inventory.checkStock({ ...context, input: { ...context.input, expectedVersion: 1 } }), err({ kind: 'Conflict' }));
});

test('all three stock implementations retain a custom commit payload and do not save after failure', async () => {
  const failed = err({ kind: 'StoreUnavailable' as const, retryAfter: 30 });
  for (const factory of [procurement, plainWithCommit, helperWithCommit]) {
    const memory = new MemoryProcurement(); let commits = 0;
    const repository: ProcurementRepository<{ kind: 'StoreUnavailable'; retryAfter: number }> = {
      read: memory.read.bind(memory), related: memory.related.bind(memory),
      commit: async () => { commits++; return failed; },
    };
    const app = factory(repository, actor('warehouse'), policy);
    const result = await app.inventory.adjust({ id: 'warehouse', expectedVersion: 0, sku: 'a', location: 'receiving', quantity: 0, reason: 'initial count' });
    assert.deepEqual(result, failed); assert.equal(commits, 1);
    if (!result.ok && result.error.kind === 'StoreUnavailable') { const seconds: number = result.error.retryAfter; assert.equal(seconds, 30); }
    assert.deepEqual(memory.list('stock', actor('warehouse')), []);
  }
});
