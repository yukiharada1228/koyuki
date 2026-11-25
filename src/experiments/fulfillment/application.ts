// Unpublished API study: two aggregates, two save contracts, explicit partial commit.
import { business } from '../business.js';
import { ok, process, type Result } from '../../framework/index.js';
import { reserve, createShipment, type Order, type Reservation, type Shipment } from './domain.js';
export interface FulfillmentPorts {
  loadStock(order: Order): Promise<Result<{ readonly order: Order; readonly available: number }, { readonly kind: 'UnknownSku' }>>;
  saveReservation(reservation: Reservation): Promise<Result<Reservation, { readonly kind: 'ReservationConflict' }>>;
  saveShipment(shipment: Shipment): Promise<Result<Shipment, { readonly kind: 'ShippingUnavailable' }>>;
}
export function fulfillment(ports: FulfillmentPorts) {
  const inventory = business({ name: 'inventory.v1', load: (order: Order) => ports.loadStock(order),
    save: (reservation: Reservation) => ports.saveReservation(reservation), operations: { reserve: [reserve] } });
  const shipping = business({ name: 'shipping.v1', load: async (reservation: Reservation) => ok(reservation),
    save: (shipment: Shipment) => ports.saveShipment(shipment), operations: { create: [createShipment] } });
  // The reservation is already saved when shipping starts. This is not a DB transaction.
  return process<Order>().effect('reserve-inventory', { runDetailed: inventory.reserve.runDetailed }).commit(shipping.create);
}
