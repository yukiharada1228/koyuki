import type { Result, Receipt, Execution } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import type { Actor, ExpenseState } from '../../expenses/domain.js';
import type { Action, Request, Loaded, BudgetChange, Budget, InvalidRequest } from './domain.js';
export type StorageError = InvalidRequest | { kind: 'Missing' | 'Conflict' | 'StorageFailed' | 'IdempotencyConflict' | 'CorruptReceipt' };
export interface Identity { readonly action: Action; readonly actor: Actor }
export interface Repository {
  load<A extends Action>(request: Request<A>, actor: Actor): Promise<Result<Loaded<A>, StorageError>>;
  receipt<A extends Action>(request: Request<A>, identity: Identity): Promise<Result<Receipt<ExpenseState>, StorageError>>;
  save<A extends Action>(change: BudgetChange, request: Request<A>, identity: Identity, events: readonly EventEnvelope[]): Promise<Result<Execution<ExpenseState>, StorageError>>;
}
export interface Snapshot { readonly expenses: readonly ExpenseState[]; readonly budget: Budget; readonly events: readonly EventEnvelope[]; readonly receipts: number }

export function fingerprint(request: Request, identity: Identity) {
  return JSON.stringify(['expense-budget.v1', identity.action, identity.actor.id, identity.actor.role, identity.actor.active,
    request.id, request.expectedVersion, identity.action === 'return' && 'reason' in request ? request.reason : null,
    identity.action === 'edit' && 'amount' in request ? request.amount : null, identity.action === 'edit' && 'receipt' in request ? request.receipt : null]);
}
export function matchesAction(action: Action, value: ExpenseState): boolean {
  return action === 'edit' ? value.kind === 'draft' : action === 'return' ? value.kind === 'returned'
    : action === 'approve' ? value.kind === 'finance' || (value.kind === 'approved' && value.approval.kind !== 'automatic')
    : value.kind === 'manager' || (value.kind === 'approved' && value.approval.kind === 'automatic');
}

/** Validate a historical receipt against the original authenticated command, without re-running current policy. */
export function receiptMatches(value: ExpenseState, request: Request, identity: Identity): boolean {
  if (!identity.actor.active || value.id !== request.id || value.version !== request.expectedVersion + 1 || !matchesAction(identity.action, value)) return false;
  if (identity.action === 'submit' || identity.action === 'edit') return value.owner === identity.actor.id;
  if (identity.action === 'return') return value.kind === 'returned' && value.by === identity.actor.id && 'reason' in request && value.reason === request.reason.trim();
  if (value.kind === 'finance') return identity.actor.role === 'manager' && value.manager === identity.actor.id;
  if (value.kind !== 'approved') return false;
  return value.approval.kind === 'manager' ? identity.actor.role === 'manager' && value.approval.manager === identity.actor.id
    : value.approval.kind === 'finance' && identity.actor.role === 'finance' && value.approval.finance === identity.actor.id;
}
