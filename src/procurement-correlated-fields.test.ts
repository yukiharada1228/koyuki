import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreEntity, type Stock } from './experiments/procurement/domain.js';
const stock: Stock = { kind: 'stock', id: 'warehouse', groupId: 'g1', version: 1, positions: [], lastAdjustment: null };

test('correlated adjustment fields are present together or absent as one value', () => {
  assert.deepEqual(restoreEntity(stock), stock);
  const adjusted: Stock = { ...stock, lastAdjustment: { reason: 'count', by: 'warehouse' } };
  assert.deepEqual(restoreEntity(adjusted), adjusted);
  for (const partial of [{ reason: 'count' }, { by: 'warehouse' }, {}, { reason: 'count', by: undefined }, { reason: undefined, by: 'warehouse' }, { reason: null, by: 'warehouse' }]) {
    const raw = { ...stock, lastAdjustment: partial };
    assert.equal(restoreEntity(raw), null);
    assert.equal(restoreEntity(JSON.parse(JSON.stringify(raw))), null);
  }
});

test('structural assignment does not replace validation of closed storage records', () => {
  const flattened = { ...stock, adjustmentReason: 'count' };
  const structurallyAccepted: Stock = flattened;
  assert.equal(structurallyAccepted.lastAdjustment, null);
  assert.equal(restoreEntity(flattened), null);
  assert.equal(restoreEntity({ ...stock, lastAdjustment: { reason: 'count', by: 'warehouse', unexpected: true } }), null);
});

function typeContracts() {
  const reasonOnly = { reason: 'count' }, actorOnly = { by: 'warehouse' };
  // @ts-expect-error a present adjustment requires both the reason and the actor
  const missingActor: Stock = { ...stock, lastAdjustment: reasonOnly };
  // @ts-expect-error a present adjustment requires both the reason and the actor
  const missingReason: Stock = { ...stock, lastAdjustment: actorOnly };
  // @ts-expect-error explicit undefined cannot fill a required adjustment field
  const undefinedActor: Stock = { ...stock, lastAdjustment: { reason: 'count', by: undefined } };
  void [missingActor, missingReason, undefinedActor];
}
void typeContracts;
