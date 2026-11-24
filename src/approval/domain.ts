import { ok, err, type Result } from '../core.js';
export type Stage = 'manager' | 'finance';
export type Input = { id: string; amount: number };
export type ValidatedOrder = { kind: 'validated-order'; id: string; amount: number };
export type ApprovedOrder = { kind: 'approved-order'; id: string; amount: number; approvals: readonly Stage[] };
export type SavedOrder = { kind: 'saved-order'; id: string; amount: number; approvals: readonly Stage[]; receipt: string };
export interface Policy { version: string; managerFrom: number; financeFrom: number | null }
export const singleApproval: Policy = { version: 'single-v1', managerFrom: 10_000, financeFrom: null };
export const extraApproval: Policy = { version: 'double-v1', managerFrom: 10_000, financeFrom: 100_000 };
export type State =
  | { kind: 'draft'; input: Input }
  | { kind: 'waiting'; order: ValidatedOrder; stage: Stage; requestId: string; approvals: readonly Stage[] }
  | { kind: 'ready'; order: ApprovedOrder }
  | { kind: 'committed'; order: SavedOrder }
  | { kind: 'complete'; order: SavedOrder }
  | { kind: 'rejected'; id: string; reason: 'InvalidInput' | 'ManagerRejected' | 'FinanceRejected' };
export type ApprovalEvent = {
  type: 'approval'; eventId: string; orderId: string; requestId: string;
  stage: Stage; actorRole: Stage; decision: 'approve' | 'reject';
};
export type Event = { type: 'advance' } | ApprovalEvent | { type: 'saved'; order: SavedOrder } | { type: 'fulfilled' };
export type TransitionError = 'UnexpectedEvent' | 'WrongRequest' | 'WrongRole' | 'InvalidSavedOrder';
function next(order: ValidatedOrder, approvals: readonly Stage[], policy: Policy): State {
  const stage = order.amount >= policy.managerFrom && !approvals.includes('manager') ? 'manager'
    : policy.financeFrom !== null && order.amount >= policy.financeFrom && !approvals.includes('finance') ? 'finance' : null;
  return stage ? { kind: 'waiting', order, approvals, stage, requestId: `${order.id}:${policy.version}:${stage}` }
    : { kind: 'ready', order: { ...order, kind: 'approved-order', approvals } };
}
export function decide(state: State, event: Event, policy: Policy): Result<State, TransitionError> {
  if (state.kind === 'draft' && event.type === 'advance') {
    const { id, amount } = state.input;
    if (!id || !Number.isSafeInteger(amount) || amount <= 0)
      return ok({ kind: 'rejected', id, reason: 'InvalidInput' });
    return ok(next({ kind: 'validated-order', id, amount }, [], policy));
  }
  if (state.kind === 'waiting' && event.type === 'approval') {
    if (event.orderId !== state.order.id || event.requestId !== state.requestId || event.stage !== state.stage) return err('WrongRequest');
    // actorRole is a trusted host-authenticated claim; this prototype does not authenticate users.
    if (event.actorRole !== state.stage) return err('WrongRole');
    if (event.decision === 'reject') return ok({ kind: 'rejected', id: state.order.id, reason: state.stage === 'manager' ? 'ManagerRejected' : 'FinanceRejected' });
    return ok(next(state.order, [...state.approvals, state.stage], policy));
  }
  if (state.kind === 'ready' && event.type === 'saved') {
    if (event.order.id !== state.order.id || event.order.amount !== state.order.amount ||
      JSON.stringify(event.order.approvals) !== JSON.stringify(state.order.approvals)) return err('InvalidSavedOrder');
    return ok({ kind: 'committed', order: event.order });
  }
  if (state.kind === 'committed' && event.type === 'fulfilled') return ok({ kind: 'complete', order: state.order });
  return err('UnexpectedEvent');
}
