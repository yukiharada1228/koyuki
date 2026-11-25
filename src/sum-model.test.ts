import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result } from './framework/index.js';

// A structural union alone is not an exclusive-or constraint.
type StructuralUser = { memberId: string } | { guestId: string };
const bothIds = { memberId: 'member-1', guestId: 'guest-1' };
const structurallyAccepted: StructuralUser = bothIds;
void structurallyAccepted;

type User =
  | { readonly kind: 'member'; readonly memberId: string; readonly guestId?: never }
  | { readonly kind: 'guest'; readonly guestId: string; readonly memberId?: never };
function restoreUser(raw: unknown): Result<User, 'InvalidUser'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err('InvalidUser');
  if (!('kind' in raw)) return err('InvalidUser');
  const keys = Object.keys(raw);
  if (raw.kind === 'member' && 'memberId' in raw && typeof raw.memberId === 'string' && raw.memberId.length > 0
    && keys.length === 2 && keys.includes('kind') && keys.includes('memberId')) return ok({ kind: 'member', memberId: raw.memberId });
  if (raw.kind === 'guest' && 'guestId' in raw && typeof raw.guestId === 'string' && raw.guestId.length > 0
    && keys.length === 2 && keys.includes('kind') && keys.includes('guestId')) return ok({ kind: 'guest', guestId: raw.guestId });
  return err('InvalidUser');
}
test('exclusive state models reject both/neither at the runtime JSON boundary', () => {
  assert.deepEqual(restoreUser({ kind: 'member', memberId: 'm' }), ok({ kind: 'member', memberId: 'm' }));
  assert.deepEqual(restoreUser({ kind: 'guest', guestId: 'g' }), ok({ kind: 'guest', guestId: 'g' }));
  for (const value of [null, [], {}, bothIds, { kind: 'member', ...bothIds }, { kind: 'guest', ...bothIds },
    { kind: 'member' }, { kind: 'member', memberId: '' }, { kind: 'guest', guestId: 1 },
    { kind: 'member', memberId: 'm', guestId: undefined }]) {
    assert.deepEqual(restoreUser(value), err('InvalidUser'));
  }
});
if (false) {
  // @ts-expect-error validated states must have a discriminant
  const noKind: User = bothIds;
  // @ts-expect-error a variable containing both IDs is rejected, not just an object literal
  const both: User = { kind: 'member' as const, ...bothIds };
  // @ts-expect-error the member branch requires its own ID
  const missing: User = { kind: 'member' };
  void [noKind, both, missing];
}
