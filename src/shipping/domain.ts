import { collect, ok, err, workflow, type Result } from '../framework/index.js';
declare const proof: unique symbol;
export interface ShippingInput { readonly orderId: unknown; readonly country: unknown; readonly weightGrams: unknown }
type InputError = { kind: 'RequiredOrderId' } | { kind: 'UnsupportedCountry' } | { kind: 'InvalidWeight' };
export type ValidShipping = Readonly<{ orderId: string; country: 'JP' | 'US'; weightGrams: number }> & { readonly [proof]: 'valid' };
const orderId = (value: unknown): Result<string, InputError> => typeof value === 'string' && value.trim() ? ok(value.trim()) : err({ kind: 'RequiredOrderId' });
const country = (value: unknown): Result<'JP' | 'US', InputError> => value === 'JP' || value === 'US' ? ok(value) : err({ kind: 'UnsupportedCountry' });
const weight = (value: unknown): Result<number, InputError> => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 30000 ? ok(value) : err({ kind: 'InvalidWeight' });
// Independent validation collects all errors; dependent business rules remain fail-fast.
export function validateShipping(input: ShippingInput) {
  const result = collect({ orderId: orderId(input.orderId), country: country(input.country), weightGrams: weight(input.weightGrams) });
  if (!result.ok) return err({ kind: 'InvalidShipping' as const, issues: result.error });
  return ok(Object.freeze(result.value) as ValidShipping);
}
interface OrderData { readonly id: string; readonly version: number; readonly totalYen: number }
export type OpenOrder = Readonly<OrderData & { status: 'open' }>;
export type ShippedOrder = Readonly<OrderData & { status: 'shipped' }>;
export type Order = OpenOrder | ShippedOrder;
/** Raw persistence/API data must be validated before becoming a domain Order. */
export function restoreOrder(raw: unknown): Result<Order, { kind: 'CorruptOrder' }> {
  if (typeof raw !== 'object' || raw === null) return err({ kind: 'CorruptOrder' });
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id.trim() ||
      typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 ||
      typeof value.totalYen !== 'number' || !Number.isSafeInteger(value.totalYen) || value.totalYen < 0)
    return err({ kind: 'CorruptOrder' });
  const data = { id: value.id, version: value.version, totalYen: value.totalYen };
  switch (value.status) {
    case 'open': return ok(Object.freeze({ ...data, status: 'open' }));
    case 'shipped': return ok(Object.freeze({ ...data, status: 'shipped' }));
    default: return err({ kind: 'CorruptOrder' });
  }
}
export interface LoadedShipping { readonly request: ValidShipping; readonly order: Order }
type RequestFor<C extends ValidShipping['country']> = ValidShipping & { readonly country: C };
type QuoteContext = { readonly order: OpenOrder; readonly [proof]: 'quote-request' };
export type QuoteRequest = Readonly<QuoteContext & (
  | { request: RequestFor<'JP'>; service: 'domestic' }
  | { request: RequestFor<'US'>; service: 'international' }
)>;
export function selectService(command: LoadedShipping): Result<QuoteRequest, { kind: 'OrderClosed' } | { kind: 'OrderMismatch' }> {
  if (command.request.orderId !== command.order.id) return err({ kind: 'OrderMismatch' });
  if (command.order.status !== 'open') return err({ kind: 'OrderClosed' });
  const order = Object.freeze({ ...command.order });
  // TS does not distribute a union-valued property into the containing object.
  if (command.request.country === 'JP') return ok(Object.freeze({ order,
    request: Object.freeze({ ...command.request, country: 'JP' as const }), service: 'domestic' as const }) as QuoteRequest);
  return ok(Object.freeze({ order,
    request: Object.freeze({ ...command.request, country: 'US' as const }), service: 'international' as const }) as QuoteRequest);
}
export interface QuotedShipping { readonly command: QuoteRequest; readonly feeYen: number }
export type ShippingDecision = Readonly<{ orderId: string; expectedVersion: number; feeYen: number; service: QuoteRequest['service'] }> & { readonly [proof]: 'decision' };
export function acceptQuote(value: QuotedShipping): Result<ShippingDecision, { kind: 'InvalidQuote' } | { kind: 'ShippingTooExpensive' }> {
  if (!Number.isSafeInteger(value.feeYen) || value.feeYen < 0) return err({ kind: 'InvalidQuote' });
  if (value.feeYen > value.command.order.totalYen) return err({ kind: 'ShippingTooExpensive' });
  return ok(Object.freeze({ orderId: value.command.order.id, expectedVersion: value.command.order.version, feeYen: value.feeYen, service: value.command.service }) as ShippingDecision);
}
export const inputWorkflow = workflow('validate-shipping', validateShipping);
export const serviceWorkflow = workflow('select-shipping-service', selectService);
export const quoteWorkflow = workflow('accept-shipping-quote', acceptQuote);
