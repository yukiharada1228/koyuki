import test from 'node:test';
import assert from 'node:assert/strict';
import { business, err, ok } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { checkStock, reserveStock, releaseStock, moveStock, adjustStock, reserveCheckedStock, releaseCheckedStock, moveCheckedStock, adjustCheckedStock } from './experiments/procurement/inventory.js';
import type { Actor, Stock, Change } from './experiments/procurement/domain.js';
const actor: Actor = { id: 'warehouse-user', role: 'warehouse', groupId: 'g1', active: true };
const policy = { requestLimitCents: 1000, approverIds: ['boss'] };
function context() {
  const stock: Stock = { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1,
    positions: [{ sku: 'a', location: 'shelf', onHand: 10, reserved: 3 }], lastAdjustment: null };
  return { actor, stock, input: { id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'shelf', quantity: 2, destination: 'other', reason: ' count ' } };
}

test('stock checks preserve context identity and independent reserve, release, move and adjustment plans', () => {
  const value = context(), before = structuredClone(value), checked = checkStock(value); assert(checked.ok);
  assert.strictEqual(checked.value, value);
  const expected = (positions: Stock['positions'], lastAdjustment: Stock['lastAdjustment'] = null) => {
    const result: Stock = { ...value.stock, version: 2, positions, lastAdjustment };
    return ok({ result, writes: [result], checks: [{ kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1 }] });
  };
  assert.deepEqual(reserveCheckedStock(checked.value), expected([{ sku: 'a', location: 'shelf', onHand: 10, reserved: 5 }]));
  assert.deepEqual(releaseCheckedStock(checked.value), expected([{ sku: 'a', location: 'shelf', onHand: 10, reserved: 1 }]));
  assert.deepEqual(moveCheckedStock(checked.value), expected([{ sku: 'a', location: 'shelf', onHand: 8, reserved: 3 }, { sku: 'a', location: 'other', onHand: 2, reserved: 0 }]));
  const adjustment = { ...value, input: { ...value.input, quantity: 6 } }, adjustCheck = checkStock(adjustment); assert(adjustCheck.ok);
  assert.deepEqual(adjustCheckedStock(adjustCheck.value), expected([{ sku: 'a', location: 'shelf', onHand: 6, reserved: 3 }], { reason: 'count', by: actor.id }));
  const empty = { ...value, stock: null, input: { ...value.input, expectedVersion: 0, quantity: 6 } }, emptyCheck = checkStock(empty); assert(emptyCheck.ok);
  const created = adjustCheckedStock(emptyCheck.value); assert(created.ok);
  assert.equal(created.value.result.version, 1); assert.deepEqual(created.value.checks, [{ kind: 'stock', id: 'warehouse', groupId: 'g1', version: null }]);
  assert.deepEqual(value, before);
});

test('stock compatibility rules keep refusal priority when several conditions are invalid', () => {
  for (const run of [reserveStock, releaseStock, moveStock, adjustStock]) {
    const value = context();
    const invalid = { ...value, input: { ...value.input, expectedVersion: 99, sku: '', destination: '', reason: '' } };
    assert.deepEqual(run({ ...invalid, actor: { ...actor, active: false }, input: { ...invalid.input, id: 'wrong' } }), err({ kind: 'Denied' }));
    assert.deepEqual(run({ ...invalid, input: { ...invalid.input, id: 'wrong' } }), err({ kind: 'TargetMismatch' }));
    assert.deepEqual(run(invalid), err({ kind: 'InvalidInput' }));
    assert.deepEqual(run({ ...value, input: { ...value.input, expectedVersion: 99, destination: '', reason: '' } }), err({ kind: 'Conflict' }));
    assert.deepEqual(run({ ...value, input: { ...value.input, expectedVersion: -1 } }), err({ kind: 'InvalidInput' }));
  }
  assert.deepEqual(moveStock({ ...context(), input: { ...context().input, quantity: 0, destination: '' } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(adjustStock({ ...context(), input: { ...context().input, quantity: 0 } }), err({ kind: 'InsufficientStock' }));
});

for (const backend of ['memory', 'sqlite']) test(`stock declarations stop at check, decision and save: ${backend}`, async () => {
  const repository = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(':memory:', 'g1');
  let attempts = 0, refuse = false;
  const tracked: ProcurementRepository = { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: (change, identity) => {
    attempts++; return refuse ? Promise.resolve(err({ kind: 'Conflict' })) : repository.commit(change, identity);
  } };
  const commands = procurement(tracked, actor, policy).inventory;
  const input = { id: 'warehouse', expectedVersion: 0, sku: 'a', location: 'shelf', quantity: 10, reason: 'seed' };
  const snapshot = () => (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).map(kind => repository.list(kind, actor));
  try {
    assert((await commands.adjust(input)).ok); assert.equal(attempts, 1);
    const before = snapshot();
    for (const name of ['reserve', 'release', 'move', 'adjust'] as const) {
      const request = { ...input, expectedVersion: 1, destination: 'other', quantity: 99 };
      const run = (input: typeof request) => name === 'reserve' ? commands.reserve.runDetailed(input) : name === 'release' ? commands.release.runDetailed(input) : name === 'move' ? commands.move.runDetailed(input) : commands.adjust.runDetailed(input);
      const check = await run({ ...request, expectedVersion: -1 });
      assert.deepEqual(check.result, err({ kind: 'InvalidInput' })); assert.deepEqual(check.trace.map(row => row.status), ['ok', 'error']); assert.equal(check.plan, null);
      const decision = await run({ ...request, ...(name === 'adjust' ? { reason: '' } : {}) });
      assert.deepEqual(decision.result, err({ kind: name === 'adjust' ? 'InvalidInput' : 'InsufficientStock' }));
      assert.deepEqual(decision.trace.map(row => row.status), ['ok', 'ok', 'error']); assert.equal(decision.plan, null);
      assert.deepEqual(snapshot(), before); assert.equal(attempts, 1);
    }
    refuse = true;
    const save = await commands.reserve.runDetailed({ ...input, expectedVersion: 1, quantity: 3 });
    assert.deepEqual(save.result, err({ kind: 'Conflict' })); assert.deepEqual(save.trace.map(row => row.status), ['ok', 'ok', 'ok', 'error']);
    assert(save.plan); assert.equal(attempts, 2); assert.deepEqual(snapshot(), before);
    refuse = false;
    assert((await commands.reserve({ ...input, expectedVersion: 1, quantity: 3 })).ok);
    assert((await commands.release({ ...input, expectedVersion: 2, quantity: 1 })).ok);
    assert((await commands.move({ ...input, expectedVersion: 3, quantity: 4, destination: 'other' })).ok);
    const result = await commands.adjust.runDetailed({ ...input, expectedVersion: 4, quantity: 6, reason: ' count ' }); assert(result.result.ok);
    assert.deepEqual(result.result.value.positions, [{ sku: 'a', location: 'shelf', onHand: 6, reserved: 2 }, { sku: 'a', location: 'other', onHand: 4, reserved: 0 }]);
    assert.equal(result.result.value.version, 5); assert.equal(attempts, 6);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts() {
  const raw = context();
  // @ts-expect-error unchecked input has no private stock proof
  reserveCheckedStock(raw);
  // @ts-expect-error a similarly named public field cannot supply the proof
  releaseCheckedStock({ ...raw, checkedStock: true });
  const checked = checkStock(raw); if (!checked.ok) return;
  moveCheckedStock(checked.value); adjustCheckedStock(checked.value);
  const broad = checkStock({ ...raw, input: { id: 'warehouse', expectedVersion: 1, sku: 'a', location: 'shelf', quantity: 2 } });
  if (broad.ok) {
    // @ts-expect-error the generic check does not invent a destination
    moveCheckedStock(broad.value);
    // @ts-expect-error the generic check does not invent an adjustment reason
    adjustCheckedStock(broad.value);
  }
  business({ name: 'valid-stock', load: async (_input: number) => ok(raw), save: async (value: Change<Stock>) => ok(value.result), operations: { reserve: [checkStock, reserveCheckedStock] } });
  business({ name: 'stock', load: async (_input: number) => ok(raw), save: async (value: Change<Stock>) => ok(value.result), operations: {
    // @ts-expect-error omitting checkStock cannot connect the loaded context to the checked rule
    reserve: [reserveCheckedStock],
  } });
}
void typeContracts;
