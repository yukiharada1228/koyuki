import { ok, err, type Result } from '../../framework/index.js';
export interface Order { readonly id: string; readonly sku: string; readonly quantity: number }
export interface Reservation { readonly kind: 'reserved'; readonly order: Order }
export interface Shipment { readonly kind: 'shipment'; readonly orderId: string; readonly sku: string; readonly quantity: number }
export type ReserveError = { readonly kind: 'InvalidQuantity' } | { readonly kind: 'OutOfStock' };
export function reserve(input: { readonly order: Order; readonly available: number }): Result<Reservation, ReserveError> {
  if (!Number.isSafeInteger(input.order.quantity) || input.order.quantity <= 0) return err({ kind: 'InvalidQuantity' });
  if (input.order.quantity > input.available) return err({ kind: 'OutOfStock' });
  return ok({ kind: 'reserved', order: { ...input.order } });
}
export function createShipment(reservation: Reservation): Result<Shipment, never> {
  return ok({ kind: 'shipment', orderId: reservation.order.id, sku: reservation.order.sku, quantity: reservation.order.quantity });
}
