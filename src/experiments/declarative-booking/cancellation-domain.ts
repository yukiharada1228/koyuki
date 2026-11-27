import { ok, err, workflow, type Result } from '../../framework/index.js';
import { restoreBooking, type Booking, type Confirmed, type Cancelled, type Actor } from './domain.js';
declare const paymentBrand: unique symbol;
export type PaymentId = string & { readonly [paymentBrand]: true };
export function paymentId(value: unknown): Result<PaymentId, 'InvalidPaymentId'> {
  return typeof value === 'string' && value.trim() ? ok(value as PaymentId) : err('InvalidPaymentId');
}
export type CancellationFacts = Readonly<{ paymentId: PaymentId; paidMinor: number; membership: 'standard' | 'premium'; paymentRevision: number; membershipRevision: number }>;
export type FeePolicy = Readonly<{ lateWithinHours: number; lateFeeBps: number }>;
export type CancellationContext = Readonly<{ booking: Booking; actor: Actor; facts: CancellationFacts; time: FeePolicy & { now: number } }>;
export type CancellationSettlement = Readonly<{ previous: Confirmed; next: Cancelled; facts: CancellationFacts; feeMinor: number; refundMinor: number }>;
export type FeeCancellationError = 'InvalidState' | 'Forbidden' | 'InvalidTime' | 'CancellationClosed' | 'InvalidPayment' | 'InvalidFeePolicy';
const verified: unique symbol = Symbol('FeeCancellationAuthorized');
type Authorized = Readonly<{ booking: Confirmed; actor: Actor; facts: CancellationFacts; feeMinor: number; [verified]: true }>;
function money(value: number) { return Number.isSafeInteger(value) && value >= 0; }
export function validFeePolicy(policy: FeePolicy): boolean {
  return Number.isFinite(policy.lateWithinHours) && policy.lateWithinHours > 0 && Number.isSafeInteger(policy.lateFeeBps) && policy.lateFeeBps >= 0 && policy.lateFeeBps <= 10_000;
}
export function authorizeFeeCancellation({ booking, actor, facts, time }: CancellationContext): Result<Authorized, FeeCancellationError> {
  if (booking.kind !== 'confirmed') return err('InvalidState');
  if (booking.owner !== actor.id) return err('Forbidden');
  if (!Number.isSafeInteger(time.now) || !Number.isSafeInteger(booking.startsAt)) return err('InvalidTime');
  if (time.now >= booking.startsAt) return err('CancellationClosed');
  if (!validFeePolicy(time)) return err('InvalidFeePolicy');
  if (!paymentId(facts.paymentId).ok || !money(facts.paidMinor) || !money(facts.paymentRevision) || !money(facts.membershipRevision) || !['standard', 'premium'].includes(facts.membership)) return err('InvalidPayment');
  const late = booking.startsAt - time.now < time.lateWithinHours * 3_600_000;
  // Exact integer arithmetic: round fees up to one minor unit; never use floats for money.
  const feeMinor = late && facts.membership === 'standard' ? Number((BigInt(facts.paidMinor) * BigInt(time.lateFeeBps) + 9_999n) / 10_000n) : 0;
  return ok(Object.freeze({ booking: Object.freeze({ ...booking }), actor: Object.freeze({ ...actor }), facts: Object.freeze({ ...facts }), feeMinor, [verified]: true as const }));
}
export function settleCancellation({ booking, actor, facts, feeMinor }: Authorized): Result<CancellationSettlement, never> {
  return ok(Object.freeze({ previous: booking, next: Object.freeze({ ...booking, kind: 'cancelled', cancelledBy: actor.id }), facts, feeMinor, refundMinor: facts.paidMinor - feeMinor }));
}
export const feeCancellation = workflow('authorize-fee-cancellation', authorizeFeeCancellation).then('settle-cancellation', settleCancellation);
/** Persisted values are untrusted; validate cross-field invariants before replay or delivery. */
export function restoreCancellationSettlement(value: unknown): Result<CancellationSettlement, 'InvalidCancellationEvent'> {
  if (!value || typeof value !== 'object' || !('previous' in value) || !('next' in value) || !('facts' in value) || !('feeMinor' in value) || !('refundMinor' in value)) return err('InvalidCancellationEvent');
  const previous = restoreBooking(value.previous), next = restoreBooking(value.next), facts = value.facts;
  if (!previous.ok || !next.ok || previous.value.kind !== 'confirmed' || next.value.kind !== 'cancelled' || next.value.id !== previous.value.id || next.value.owner !== previous.value.owner || next.value.approvedBy !== previous.value.approvedBy || next.value.startsAt !== previous.value.startsAt || next.value.cancelledBy !== next.value.owner) return err('InvalidCancellationEvent');
  if (!facts || typeof facts !== 'object' || !('paymentId' in facts) || !('paidMinor' in facts) || !('membership' in facts) || !('paymentRevision' in facts) || !('membershipRevision' in facts)) return err('InvalidCancellationEvent');
  const id = paymentId(facts.paymentId);
  if (!id.ok || typeof facts.paidMinor !== 'number' || !money(facts.paidMinor) || (facts.membership !== 'standard' && facts.membership !== 'premium') || typeof facts.paymentRevision !== 'number' || !money(facts.paymentRevision) || typeof facts.membershipRevision !== 'number' || !money(facts.membershipRevision) || typeof value.feeMinor !== 'number' || !money(value.feeMinor) || typeof value.refundMinor !== 'number' || !money(value.refundMinor) || value.feeMinor > facts.paidMinor || value.refundMinor !== facts.paidMinor - value.feeMinor || (facts.membership === 'premium' && value.feeMinor !== 0)) return err('InvalidCancellationEvent');
  return ok(Object.freeze({ previous: previous.value, next: next.value, facts: Object.freeze({ paymentId: id.value, paidMinor: facts.paidMinor, membership: facts.membership, paymentRevision: facts.paymentRevision, membershipRevision: facts.membershipRevision }), feeMinor: value.feeMinor, refundMinor: value.refundMinor }));
}

export type CancellationRecord = Readonly<{ requestId: string; settlement: CancellationSettlement }>;
export function restoreCancellationRecord(value: unknown): Result<CancellationRecord, 'InvalidCancellationEvent'> {
  if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string' || !value.requestId.trim() || !('settlement' in value)) return err('InvalidCancellationEvent');
  const settlement = restoreCancellationSettlement(value.settlement);
  return settlement.ok ? ok(Object.freeze({ requestId: value.requestId, settlement: settlement.value })) : settlement;
}
