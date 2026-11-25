import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRecord, type AuditIdentity, type AuditChange, type AuditRecord } from './framework/index.js';
const identity: AuditIdentity = { actorId: 'host-user', operationId: 'request-1', definitionVersion: 'v1', occurredAt: '2026-11-25T00:00:00.000Z' };
const change: AuditChange = { targetType: 'expense', targetId: 'e1', beforeVersion: 1, afterVersion: 2 };
test('audit selects immutable primitive metadata without reading extra payload properties', () => {
  const extra = { ...identity, secret: 'token', get payload(): never { throw Error('unselected getter'); } };
  const detail = { ...change, state: { amount: 999, reason: 'secret' } };
  const record: AuditRecord = auditRecord(extra, 'expense.submit.v1', detail);
  assert.deepEqual(record, { schema: 'koyuki.audit.v1', operation: 'expense.submit.v1', ...identity, ...change });
  assert(Object.isFrozen(record));
  extra.actorId = 'changed'; detail.afterVersion = 3;
  assert.equal(record.actorId, 'host-user'); assert.equal(record.afterVersion, 2);
  assert(!JSON.stringify(record).includes('secret'));
});
test('audit validates identifiers, timestamp and consecutive safe versions', () => {
  for (const patch of [{ actorId: '' }, { operationId: ' request ' }, { definitionVersion: 'x'.repeat(201) }, { occurredAt: 'yesterday' }, { occurredAt: '2026-11-25' }]) {
    assert.throws(() => auditRecord({ ...identity, ...patch }, 'submit', change), { message: 'Invalid audit metadata' });
  }
  for (const patch of [{ targetId: '' }, { beforeVersion: 0 }, { afterVersion: 1 }, { afterVersion: 3 }, { afterVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => auditRecord(identity, 'submit', { ...change, ...patch }), { message: 'Invalid audit metadata' });
  }
  assert.equal(auditRecord(identity, 'create', { ...change, beforeVersion: null, afterVersion: 1 }).beforeVersion, null);
});
