import { ok, err, type Result } from 'koyuki';

export type Operation = 'reserve' | 'confirm' | 'cancel';
// This sample uses one immutable order line per orderId. Actor authentication is host-owned.
export interface Input { readonly requestId: string; readonly orderId: string; readonly sku: string; readonly quantity: number }
export interface Stock { readonly sku: string; readonly onHand: number; readonly reserved: number; readonly version: number }
interface Line { readonly orderId: string; readonly sku: string; readonly quantity: number }
export type Unreserved = Readonly<Line & { kind: 'unreserved'; version: 0 }>;
export type Reserved = Readonly<Line & { kind: 'reserved'; version: 1 }>;
export type Confirmed = Readonly<Line & { kind: 'confirmed'; version: 2 }>;
export type Cancelled = Readonly<Line & { kind: 'cancelled'; version: 2 }>;
export type Reservation = Unreserved | Reserved | Confirmed | Cancelled;
export interface Loaded { readonly operation: Operation; readonly input: Input; readonly stock: Stock; readonly reservation: Reservation }
export interface Outcome { readonly stock: Stock; readonly reservation: Exclude<Reservation, Unreserved> }
export type DomainError = { kind: 'InvalidInput' } | { kind: 'InvalidState' } | { kind: 'OrderMismatch' } | { kind: 'InsufficientStock'; available: number };
declare const proof: unique symbol;
export type Reservable = Loaded & { readonly reservation: Unreserved; readonly [proof]: 'reserve' };
export type Held = Loaded & { readonly reservation: Reserved; readonly [proof]: 'held' };
export interface Change {
  readonly operation: Operation; readonly input: Input;
  readonly expectedStockVersion: number; readonly expectedReservationVersion: number;
  readonly next: Outcome; readonly [proof]: 'change';
}
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200 && x.trim() === x;
const integer = (x: unknown): x is number => Number.isSafeInteger(x);
export function validInput(value: unknown): value is Input {
  if (!value || typeof value !== 'object') return false;
  const x = value as Record<string, unknown>;
  return text(x.requestId) && text(x.orderId) && text(x.sku) && integer(x.quantity) && x.quantity > 0;
}
export function validStock(value: unknown): value is Stock {
  if (!value || typeof value !== 'object') return false;
  const x = value as Record<string, unknown>;
  return text(x.sku) && integer(x.onHand) && x.onHand >= 0 && integer(x.reserved) && x.reserved >= 0 &&
    x.reserved <= x.onHand && integer(x.version) && x.version >= 1;
}
export function validReservation(value: unknown): value is Reservation {
  if (!value || typeof value !== 'object') return false;
  const x = value as Record<string, unknown>;
  if (!text(x.orderId) || !text(x.sku) || !integer(x.quantity) || x.quantity <= 0) return false;
  return (x.kind === 'unreserved' && x.version === 0) || (x.kind === 'reserved' && x.version === 1) ||
    ((x.kind === 'confirmed' || x.kind === 'cancelled') && x.version === 2);
}
export function validOutcome(value: unknown): value is Outcome {
  if (!value || typeof value !== 'object') return false;
  const x = value as Record<string, unknown>;
  return validStock(x.stock) && validReservation(x.reservation) && x.reservation.kind !== 'unreserved' && x.stock.sku === x.reservation.sku;
}
function matches(c: Loaded): Result<Loaded, DomainError> {
  const { input: i, reservation: r } = c;
  if (!validInput(i)) return err({ kind: 'InvalidInput' });
  if (r.orderId !== i.orderId || r.sku !== i.sku || r.quantity !== i.quantity) return err({ kind: 'OrderMismatch' });
  return ok(c);
}
export function validateReserve(c: Loaded): Result<Reservable, DomainError> {
  const match = matches(c); if (!match.ok) return match;
  if (c.operation !== 'reserve' || c.reservation.kind !== 'unreserved') return err({ kind: 'InvalidState' });
  return ok(c as Reservable);
}
export function requireStock(c: Reservable): Result<Reservable, DomainError> {
  const available = c.stock.onHand - c.stock.reserved;
  return available >= c.input.quantity ? ok(c) : err({ kind: 'InsufficientStock', available });
}
export function validateHeld(c: Loaded): Result<Held, DomainError> {
  const match = matches(c); if (!match.ok) return match;
  if ((c.operation !== 'confirm' && c.operation !== 'cancel') || c.reservation.kind !== 'reserved') return err({ kind: 'InvalidState' });
  return ok(c as Held);
}
function change(c: Loaded, next: Outcome): Result<Change, DomainError> {
  if (!validOutcome(next)) return err({ kind: 'InvalidState' });
  return ok(Object.freeze({ operation: c.operation, input: Object.freeze({ ...c.input }),
    expectedStockVersion: c.stock.version, expectedReservationVersion: c.reservation.version,
    next: Object.freeze({ stock: Object.freeze(next.stock), reservation: Object.freeze(next.reservation) }) }) as Change);
}
export function reserve(c: Reservable): Result<Change, DomainError> {
  // Keep this exported pure function safe even if requireStock is omitted by a caller.
  const enough = requireStock(c); if (!enough.ok) return enough;
  return change(c, { stock: { ...c.stock, reserved: c.stock.reserved + c.input.quantity, version: c.stock.version + 1 },
    reservation: { ...c.reservation, kind: 'reserved', version: 1 } });
}
export function confirm(c: Held): Result<Change, DomainError> {
  if (c.operation !== 'confirm') return err({ kind: 'InvalidState' });
  return change(c, { stock: { ...c.stock, onHand: c.stock.onHand - c.input.quantity, reserved: c.stock.reserved - c.input.quantity, version: c.stock.version + 1 },
    reservation: { ...c.reservation, kind: 'confirmed', version: 2 } });
}
export function cancel(c: Held): Result<Change, DomainError> {
  if (c.operation !== 'cancel') return err({ kind: 'InvalidState' });
  return change(c, { stock: { ...c.stock, reserved: c.stock.reserved - c.input.quantity, version: c.stock.version + 1 },
    reservation: { ...c.reservation, kind: 'cancelled', version: 2 } });
}
