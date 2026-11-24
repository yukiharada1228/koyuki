import { ok, err } from '../framework/index.js';
import { createShippingAction, shippingPlain, type ShippingPorts } from './feature.js';
import { restoreOrder, type ShippingInput } from './domain.js';
// In-memory demonstration, not a production shipping provider or DB adapter.
function adapters() {
  const calls: string[] = [];
  let version = 1;
  const ports: ShippingPorts = {
    async loadOrder(request) {
      calls.push('load-order');
      const order = restoreOrder({ id: request.orderId, version, status: 'open', totalYen: 10000 });
      return order.ok ? ok({ request, order: order.value }) : order;
    },
    async quote(command) {
      calls.push('quote:' + command.service);
      return ok({ command, feeYen: command.service === 'domestic' ? 700 : 3000 });
    },
    async save(decision) {
      calls.push('save');
      if (decision.expectedVersion !== version) return err({ kind: 'SaveConflict' });
      return ok({ orderId: decision.orderId, version: ++version });
    },
  };
  return { ports, calls };
}
for (const input of [
  { orderId: 'o1', country: 'JP', weightGrams: 1000 },
  { orderId: 'o1', country: 'US', weightGrams: 1000 },
  { orderId: '', country: 'XX', weightGrams: -1 },
] satisfies ShippingInput[]) {
  const a = adapters(), b = adapters();
  const report = await createShippingAction(a.ports).runDetailed(input);
  const plain = await shippingPlain(b.ports, input);
  console.log(JSON.stringify({ input, framework: report, plain, calls: a.calls, sameResult: JSON.stringify(report.result) === JSON.stringify(plain) }, null, 2));
}
