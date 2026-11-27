import { decide, type Request } from './domain.js';
import { err } from '../../framework/index.js';
import type { Actor } from '../../expenses/domain.js';
import type { Repository, Snapshot } from './repository.js';
/** Observation is a verification surface, not a production Repository requirement. */
export interface InspectableRepository extends Repository { snapshot(): Snapshot; auditCount(): number; close(): void }
export interface ContractAssertions { equal(actual: unknown, expected: unknown): void; deepEqual(actual: unknown, expected: unknown): void }
/** Reuse against a seeded adapter. Caller supplies its assertion library and lifecycle. */
export async function checkRepositoryContract(db: InspectableRepository, actor: Actor, request: Request<'submit'>, assert: ContractAssertions) {
  const loaded = await db.load(request, actor);
  if (!loaded.ok) throw new Error('ContractFixtureLoadFailed');
  const next = decide('submit', loaded.value);
  if (!next.ok) throw new Error('ContractFixtureDecisionFailed');
  const identity = { action: 'submit' as const, actor };
  const initial = db.snapshot();
  const duplicate = { id: 'contract-duplicate', type: 'contract-event', payload: next.value.expense.next };
  assert.deepEqual(await db.save(next.value, request, identity, [duplicate, duplicate]), err({ kind: 'StorageFailed' }));
  assert.deepEqual(db.snapshot(), initial); assert.equal(db.auditCount(), 0);
  const results = await Promise.all([db.save(next.value, request, identity, []), db.save(next.value, request, identity, [])]);
  assert.equal(results.filter(value => value.ok && value.value.kind === 'committed').length, 1);
  assert.equal(results.filter(value => value.ok && value.value.kind === 'replayed').length, 1);
  const available = loaded.value.budget.available + next.value.delta;
  assert.equal(db.snapshot().budget.available, available); assert.equal(db.auditCount(), 1);
  assert.deepEqual(await db.receipt({ ...request, id: `${request.id}-different` }, identity), err({ kind: 'IdempotencyConflict' }));
  const before = db.snapshot();
  const stale = await db.save(next.value, { ...request, requestId: `${request.requestId}-stale` }, identity, []);
  assert.deepEqual(stale, err({ kind: 'Conflict' })); assert.deepEqual(db.snapshot(), before);
  Object.assign(db.snapshot().budget, { available: 999999 });
  assert.equal(db.snapshot().budget.available, available);
}
