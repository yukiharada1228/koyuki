import { process, bindMutation, type Result } from '../framework/index.js';
import { inputWorkflow, serviceWorkflow, quoteWorkflow, type ShippingInput, type ValidShipping, type LoadedShipping, type QuoteRequest, type QuotedShipping, type ShippingDecision } from './domain.js';
export interface ShippingPorts {
  loadOrder(request: ValidShipping): Promise<Result<LoadedShipping, { kind: 'OrderNotFound' } | { kind: 'CorruptOrder' }>>;
  // Read-only quote lookup, after the pure workflow has chosen the shipping service.
  quote(command: QuoteRequest): Promise<Result<QuotedShipping, { kind: 'QuoteUnavailable' }>>;
  // Atomically check expectedVersion and status before saving; no automatic retry.
  save(decision: ShippingDecision): Promise<Result<{ orderId: string; version: number }, { kind: 'SaveConflict' }>>;
}
export function createShippingAction(ports: ShippingPorts) {
  const mutation = bindMutation({ workflow: quoteWorkflow, operation: 'shipping.save.v1', save: ports.save.bind(ports) });
  return process<ShippingInput>()
    .through(inputWorkflow)
    .effect('load-order', ports.loadOrder.bind(ports))
    .through(serviceWorkflow)
    .effect('fetch-shipping-quote', ports.quote.bind(ports))
    .commit(mutation);
}
// Same rules and ports, without orchestration helpers: a comparison baseline.
export async function shippingPlain(ports: ShippingPorts, input: ShippingInput) {
  const valid = inputWorkflow.run(input); if (!valid.ok) return valid;
  const loaded = await ports.loadOrder(valid.value); if (!loaded.ok) return loaded;
  const service = serviceWorkflow.run(loaded.value); if (!service.ok) return service;
  const quoted = await ports.quote(service.value); if (!quoted.ok) return quoted;
  const decision = quoteWorkflow.run(quoted.value); if (!decision.ok) return decision;
  return ports.save(decision.value);
}
