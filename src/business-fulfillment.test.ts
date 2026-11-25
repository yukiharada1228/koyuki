import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err } from './framework/index.js';
import { fulfillment, type FulfillmentPorts } from './experiments/fulfillment/application.js';
import type { Order, Reservation, Shipment } from './experiments/fulfillment/domain.js';
const order: Order = { id: 'order-1', sku: 'book', quantity: 2 };
function fixture() {
  let stock = 5, unavailable = false, reservationWrites = 0, shipmentWrites = 0;
  const reservations = new Map<string, Reservation>(), shipments = new Map<string, Shipment>();
  const calls: string[] = [];
  const ports: FulfillmentPorts = {
    async loadStock(input) {
      calls.push('load-stock');
      if (input.sku !== 'book') return err({ kind: 'UnknownSku' });
      // Reserved units still belong to this order during a retry. Other orders cannot consume them.
      const own = reservations.get(input.id);
      return ok({ order: input, available: stock + (own?.order.quantity ?? 0) });
    },
    async saveReservation(value) {
      calls.push('save-reservation');
      const previous = reservations.get(value.order.id);
      if (previous) return previous.order.sku === value.order.sku && previous.order.quantity === value.order.quantity
        ? ok(structuredClone(previous)) : err({ kind: 'ReservationConflict' });
      stock -= value.order.quantity; reservationWrites++;
      reservations.set(value.order.id, structuredClone(value));
      return ok(structuredClone(value));
    },
    async saveShipment(value) {
      calls.push('save-shipment');
      if (unavailable) return err({ kind: 'ShippingUnavailable' });
      const previous = shipments.get(value.orderId);
      if (previous) return ok(structuredClone(previous));
      shipmentWrites++; shipments.set(value.orderId, structuredClone(value));
      return ok(structuredClone(value));
    },
  };
  return { ports, calls, reservations, shipments, failShipping: (value: boolean) => { unavailable = value; },
    counts: () => ({ stock, reservationWrites, shipmentWrites }) };
}
test('two business declarations keep distinct save/output contracts and run only on invocation', async () => {
  const f = fixture(), command = fulfillment(f.ports);
  assert.deepEqual(f.calls, []);
  const report = await command.runDetailed(order);
  assert.deepEqual(report.result, ok({ kind: 'shipment', orderId: order.id, sku: order.sku, quantity: 2 }));
  assert.deepEqual(f.calls, ['load-stock', 'save-reservation', 'save-shipment']);
  assert.deepEqual(report.trace.map(t => t.step), ['reserve-inventory', 'shipping.v1.create:load', 'run:1', 'shipping.v1.create']);
  assert.deepEqual(f.counts(), { stock: 3, reservationWrites: 1, shipmentWrites: 1 });
});
test('reservation validation failure stops both saves and the second aggregate', async () => {
  for (const [quantity, kind] of [[0, 'InvalidQuantity'], [6, 'OutOfStock']] as const) {
    const f = fixture();
    assert.deepEqual(await fulfillment(f.ports).run({ ...order, quantity }), err({ kind }));
    assert.deepEqual(f.calls, ['load-stock']);
    assert.deepEqual(f.counts(), { stock: 5, reservationWrites: 0, shipmentWrites: 0 });
  }
});
test('second-save failure retains first commit; explicit retry uses adapter idempotency', async () => {
  const f = fixture(); f.failShipping(true);
  const command = fulfillment(f.ports);
  assert.deepEqual(await command.run(order), err({ kind: 'ShippingUnavailable' }));
  assert.equal(f.reservations.size, 1); assert.equal(f.shipments.size, 0);
  assert.deepEqual(f.counts(), { stock: 3, reservationWrites: 1, shipmentWrites: 0 });
  f.failShipping(false);
  assert((await command.run(order)).ok);
  assert((await command.run(order)).ok);
  assert.deepEqual(f.counts(), { stock: 3, reservationWrites: 1, shipmentWrites: 1 });
  const before = f.calls.filter(call => call === 'save-shipment').length;
  assert.deepEqual(await command.run({ ...order, quantity: 1 }), err({ kind: 'ReservationConflict' }));
  assert.equal(f.calls.filter(call => call === 'save-shipment').length, before);
});
// Different aggregate output cannot be silently passed to a shipment-only save.
if (false) {
  const wrong = { ...fixture().ports, saveShipment: async (_value: Reservation) => ok(order) };
  // @ts-expect-error shipment persistence is not reservation persistence
  fulfillment(wrong);
}
