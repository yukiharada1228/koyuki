// Evaluation domain, not a specification of the lecture author's product.
import { ok, err, type Result } from '../../framework/index.js';
export type Actor = Readonly<{ id: string; groupId: string; role: 'buyer' | 'approver' | 'warehouse' | 'finance'; active: boolean }>;
export type Policy = Readonly<{ requestLimitCents: number; approverIds: readonly string[] }>;
declare const lineProof: unique symbol;
export type Line = Readonly<{ sku: string; quantity: number; unitCents: number }> & { readonly [lineProof]: true };
export type Quantity = Readonly<{ sku: string; quantity: number }>;
declare const stateProof: unique symbol;
type Opaque<K extends string> = { readonly [stateProof]: K };
function stamp<const K extends string, const T extends object>(state: K, value: T): Omit<T, typeof stateProof> & Opaque<K> { return value as Omit<T, typeof stateProof> & Opaque<K>; }
type Base = Readonly<{ id: string; groupId: string; version: number }>;
type RequestBase = Base & Readonly<{ kind: 'request'; ownerId: string; lines: readonly Line[]; totalCents: number }>;
export type Draft = RequestBase & Readonly<{ state: 'draft' }> & Opaque<'request-draft'>;
export type Submitted = RequestBase & Readonly<{ state: 'submitted'; approverId: string }> & Opaque<'request-submitted'>;
export type Approved = RequestBase & Readonly<{ state: 'approved'; approverId: string; approvedBy: string }> & Opaque<'request-approved'>;
export type Rejected = RequestBase & Readonly<{ state: 'rejected'; rejectedBy: string; reason: string }> & Opaque<'request-rejected'>;
export type Request = Draft | Submitted | Approved | Rejected;
export type Order = Base & Readonly<{ kind: 'order'; state: 'placed' | 'cancelled' | 'completed'; requestId: string; ownerId: string; supplier: string; lines: readonly Line[]; totalCents: number }>;
type ReceiptBase = Base & Readonly<{ kind: 'receipt'; orderId: string; quantities: readonly Quantity[] }>;
export type Receipt = ReceiptBase & (Readonly<{ state: 'accepted' }> | Readonly<{ state: 'returned'; reason: string; returnedBy: string }>);
type InvoiceBase = Base & Readonly<{ kind: 'invoice'; orderId: string; amountCents: number }>;
export type Invoice = InvoiceBase & (Readonly<{ state: 'registered' }> | Readonly<{ state: 'matched'; receiptIds: readonly string[] }> | Readonly<{ state: 'approved'; receiptIds: readonly string[]; approvedBy: string }> | Readonly<{ state: 'voided'; reason: string; voidedBy: string }>);
type PaymentBase = Base & Readonly<{ kind: 'payment'; invoiceId: string; amountCents: number; reference: string; recordedBy: string }>;
export type Payment = PaymentBase & (Readonly<{ state: 'recorded' }> | Readonly<{ state: 'cancelled'; reason: string; cancelledBy: string }>);
export type Entity = Request | Order | Receipt | Invoice | Payment;
export type Check = Readonly<{ kind: Entity['kind']; id: string; groupId: string; version: number | null }>;
export type Change<T extends Entity> = Readonly<{ result: T; writes: readonly Entity[]; checks: readonly Check[] }>;
export type RuleError = Readonly<{ kind: 'Denied' | 'InvalidInput' | 'WrongState' | 'Conflict' | 'BudgetExceeded' | 'AlreadyExists' | 'QuantityExceeded' | 'InvoiceMismatch' | 'TargetMismatch' }>;
export type CreateInput = Readonly<{ id: string; lines: unknown }>;
export type VersionInput = Readonly<{ id: string; expectedVersion: number }>;
export type EditInput = VersionInput & Readonly<{ lines: unknown }>;
export type ReasonInput = VersionInput & Readonly<{ reason: string }>;
export type SubmitInput = VersionInput & Readonly<{ approverId: string }>;
export type PlaceInput = VersionInput & Readonly<{ orderId: string; supplier: string }>;
export type AmendInput = VersionInput & Readonly<{ supplier: string }>;
export type ReceiveInput = VersionInput & Readonly<{ receiptId: string; quantities: unknown }>;
export type CorrectInput = VersionInput & Readonly<{ quantities: unknown }>;
export type RegisterInput = VersionInput & Readonly<{ invoiceId: string; amountCents: number }>;
export type PaymentInput = VersionInput & Readonly<{ paymentId: string; reference: string }>;
export type Loaded<I, T> = Readonly<{ input: I; actor: Actor; current: T }>;
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value === value.trim();
const integer = (value: number) => Number.isSafeInteger(value) && value > 0;
function allowed(actor: Actor, role: Actor['role'], groupId: string): boolean { return actor.active === true && id(actor.id) && id(groupId) && actor.role === role && actor.groupId === groupId; }
export const check = (entity: Entity): Check => ({ kind: entity.kind, id: entity.id, groupId: entity.groupId, version: entity.version });
const absent = (kind: Entity['kind'], groupId: string, id: string): Check => ({ kind, groupId, id, version: null });
const plan = <T extends Entity>(result: T, checks: readonly Check[], writes: readonly Entity[] = [result]): Change<T> => ({ result, writes, checks });
const failure = (kind: RuleError['kind']): Result<never, RuleError> => err({ kind });
function lines(value: unknown): Result<readonly Line[], RuleError> {
  if (!Array.isArray(value) || !value.length || value.length > 1000) return failure('InvalidInput');
  const seen = new Set<string>(), parsed: Line[] = [];
  let total = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return failure('InvalidInput');
    const row = raw as Record<string, unknown>;
    if (typeof row.sku !== 'string' || !id(row.sku) || seen.has(row.sku) || typeof row.quantity !== 'number' || !integer(row.quantity) || typeof row.unitCents !== 'number' || !integer(row.unitCents)) return failure('InvalidInput');
    total += row.quantity * row.unitCents;
    if (!Number.isSafeInteger(total)) return failure('InvalidInput');
    seen.add(row.sku); parsed.push(Object.freeze({ sku: row.sku, quantity: row.quantity, unitCents: row.unitCents }) as Line);
  }
  return ok(Object.freeze(parsed));
}
export function createRequest(value: Readonly<{ input: CreateInput; actor: Actor }>): Result<Change<Draft>, RuleError> {
  const { input, actor } = value;
  if (!allowed(actor, 'buyer', actor.groupId)) return failure('Denied');
  if (!id(input.id)) return failure('InvalidInput');
  const parsed = lines(input.lines); if (!parsed.ok) return parsed;
  const result: Draft = stamp('request-draft', { kind: 'request', state: 'draft', id: input.id, groupId: actor.groupId, ownerId: actor.id, version: 1,
    lines: parsed.value, totalCents: parsed.value.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) });
  return ok(plan(result, [absent('request', actor.groupId, input.id)]));
}
export function submitRequest(value: Loaded<SubmitInput, Request> & Readonly<{ policy: Policy }>): Result<Change<Submitted>, RuleError> {
  const { input, actor, current, policy } = value;
  if (!allowed(actor, 'buyer', current.groupId) || actor.id !== current.ownerId) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'draft') return failure('WrongState');
  if (!id(input.approverId) || !policy.approverIds.includes(input.approverId) || input.approverId === current.ownerId) return failure('InvalidInput');
  if (!integer(policy.requestLimitCents) || current.totalCents > policy.requestLimitCents) return failure('BudgetExceeded');
  return ok(plan(stamp('request-submitted', { ...current, state: 'submitted', approverId: input.approverId, version: current.version + 1 }), [check(current)]));
}
export function approveRequest(value: Loaded<VersionInput, Request>): Result<Change<Approved>, RuleError> {
  const { input, actor, current } = value;
  if (!allowed(actor, 'approver', current.groupId) || actor.id === current.ownerId) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'submitted') return failure('WrongState');
  if (current.approverId !== actor.id) return failure('Denied');
  return ok(plan(stamp('request-approved', { ...current, state: 'approved', approvedBy: actor.id, version: current.version + 1 }), [check(current)]));
}
export function placeOrder(value: Loaded<PlaceInput, Request> & Readonly<{ alreadyOrdered: boolean }>): Result<Change<Order>, RuleError> {
  const { input, actor, current } = value;
  if (!allowed(actor, 'buyer', current.groupId) || actor.id !== current.ownerId) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'approved') return failure('WrongState');
  if (!id(input.orderId) || typeof input.supplier !== 'string' || !input.supplier.trim()) return failure('InvalidInput');
  if (value.alreadyOrdered) return failure('AlreadyExists');
  const order: Order = { kind: 'order', state: 'placed', id: input.orderId, groupId: current.groupId, version: 1,
    requestId: current.id, ownerId: current.ownerId, supplier: input.supplier.trim(), lines: current.lines, totalCents: current.totalCents };
  return ok(plan(order, [check(current), absent('order', current.groupId, order.id)]));
}
export function receiveOrder(value: Loaded<ReceiveInput, Order> & Readonly<{ receipts: readonly Receipt[] }>): Result<Change<Receipt>, RuleError> {
  const { input, actor, current, receipts } = value;
  if (!allowed(actor, 'warehouse', current.groupId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'placed') return failure('WrongState');
  if (!id(input.receiptId) || !Array.isArray(input.quantities) || !input.quantities.length) return failure('InvalidInput');
  if (receipts.some(receipt => receipt.groupId !== current.groupId || receipt.orderId !== current.id)) return failure('TargetMismatch');
  const quantities: Quantity[] = [], seen = new Set<string>();
  for (const raw of input.quantities) {
    if (!raw || typeof raw !== 'object') return failure('InvalidInput');
    const row = raw as Record<string, unknown>;
    if (!id(row.sku) || typeof row.quantity !== 'number' || !integer(row.quantity) || seen.has(row.sku)) return failure('InvalidInput');
    const ordered = current.lines.find(line => line.sku === row.sku);
    const received = receipts.filter(receipt => receipt.state === 'accepted').flatMap(receipt => receipt.quantities).filter(line => line.sku === row.sku).reduce((sum, line) => sum + line.quantity, 0);
    if (!ordered || !Number.isSafeInteger(received + row.quantity) || received + row.quantity > ordered.quantity) return failure('QuantityExceeded');
    seen.add(row.sku); quantities.push(Object.freeze({ sku: row.sku, quantity: row.quantity }));
  }
  const receipt: Receipt = { kind: 'receipt', state: 'accepted', id: input.receiptId, groupId: current.groupId, orderId: current.id, version: 1, quantities: Object.freeze(quantities) };
  return ok(plan(receipt, [check(current), absent('receipt', current.groupId, receipt.id)], [{ ...current, version: current.version + 1 }, receipt]));
}
export function registerInvoice(value: Loaded<RegisterInput, Order> & Readonly<{ alreadyInvoiced: boolean }>): Result<Change<Invoice>, RuleError> {
  const { input, actor, current } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'placed') return failure('WrongState');
  if (!id(input.invoiceId) || !integer(input.amountCents)) return failure('InvalidInput');
  if (value.alreadyInvoiced) return failure('AlreadyExists');
  const invoice: Invoice = { kind: 'invoice', state: 'registered', id: input.invoiceId, groupId: current.groupId, orderId: current.id, version: 1, amountCents: input.amountCents };
  return ok(plan(invoice, [check(current), absent('invoice', current.groupId, invoice.id)], [{ ...current, version: current.version + 1 }, invoice]));
}
export function matchInvoice(value: Loaded<VersionInput, Invoice> & Readonly<{ order: Order; receipts: readonly Receipt[] }>): Result<Change<Invoice>, RuleError> {
  const { input, actor, current, order, receipts } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'registered') return failure('WrongState');
  if (order.id !== current.orderId || order.groupId !== current.groupId || receipts.some(receipt => receipt.orderId !== order.id || receipt.groupId !== current.groupId)) return failure('TargetMismatch');
  if (current.amountCents !== order.totalCents || order.lines.some(line => receipts.filter(receipt => receipt.state === 'accepted').flatMap(receipt => receipt.quantities).filter(item => item.sku === line.sku).reduce((sum, item) => sum + item.quantity, 0) !== line.quantity)) return failure('InvoiceMismatch');
  return ok(plan({ ...current, state: 'matched', receiptIds: receipts.filter(receipt => receipt.state === 'accepted').map(receipt => receipt.id), version: current.version + 1 }, [check(current), check(order)]));
}

// Shared checks describe this domain's ownership and version rules, not runtime orchestration.
function requestGuard(value: Loaded<VersionInput, Request>, role: 'buyer' | 'approver'): Result<Request, RuleError> {
  const { input, actor, current } = value;
  if (!allowed(actor, role, current.groupId) || (role === 'buyer' ? actor.id !== current.ownerId : actor.id === current.ownerId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (role === 'approver' && current.state === 'submitted' && current.approverId !== actor.id) return failure('Denied');
  return ok(current);
}
function draftFrom(current: Request): Draft {
  return stamp('request-draft', { kind: 'request', state: 'draft', id: current.id, groupId: current.groupId,
    ownerId: current.ownerId, lines: current.lines, totalCents: current.totalCents, version: current.version + 1 });
}
export function editRequest(value: Loaded<EditInput, Request>): Result<Change<Draft>, RuleError> {
  const checked = requestGuard(value, 'buyer'); if (!checked.ok) return checked;
  if (checked.value.state !== 'draft') return failure('WrongState');
  const parsed = lines(value.input.lines); if (!parsed.ok) return parsed;
  const result: Draft = { ...draftFrom(checked.value), lines: parsed.value, totalCents: parsed.value.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) };
  return ok(plan(result, [check(checked.value)]));
}
export function withdrawRequest(value: Loaded<VersionInput, Request>): Result<Change<Draft>, RuleError> {
  const checked = requestGuard(value, 'buyer'); if (!checked.ok) return checked;
  if (checked.value.state !== 'submitted') return failure('WrongState');
  return ok(plan(draftFrom(checked.value), [check(checked.value)]));
}
export function rejectRequest(value: Loaded<ReasonInput, Request>): Result<Change<Rejected>, RuleError> {
  const checked = requestGuard(value, 'approver'); if (!checked.ok) return checked;
  const current = checked.value;
  if (current.state !== 'submitted') return failure('WrongState');
  if (typeof value.input.reason !== 'string' || !value.input.reason.trim() || value.input.reason.trim().length > 1000) return failure('InvalidInput');
  const result: Rejected = stamp('request-rejected', { kind: 'request', state: 'rejected', id: current.id, groupId: current.groupId,
    ownerId: current.ownerId, lines: current.lines, totalCents: current.totalCents, version: current.version + 1,
    rejectedBy: value.actor.id, reason: value.input.reason.trim() });
  return ok(plan(result, [check(current)]));
}
export function returnRequest(value: Loaded<VersionInput, Request>): Result<Change<Draft>, RuleError> {
  const checked = requestGuard(value, 'approver'); if (!checked.ok) return checked;
  if (checked.value.state !== 'submitted') return failure('WrongState');
  return ok(plan(draftFrom(checked.value), [check(checked.value)]));
}
export function reassignRequest(value: Loaded<SubmitInput, Request> & Readonly<{ policy: Policy }>): Result<Change<Submitted>, RuleError> {
  const checked = requestGuard(value, 'approver'); if (!checked.ok) return checked;
  const current = checked.value, next = value.input.approverId;
  if (current.state !== 'submitted') return failure('WrongState');
  if (!id(next) || next === current.ownerId || next === current.approverId || !value.policy.approverIds.includes(next)) return failure('InvalidInput');
  return ok(plan(stamp('request-submitted', { ...current, approverId: next, version: current.version + 1 }), [check(current)]));
}

export type OrderFacts = Readonly<{ receipts: readonly Receipt[]; invoices: readonly Invoice[] }>;
function orderGuard(value: Loaded<VersionInput, Order> & OrderFacts): Result<Order, RuleError> {
  const { input, actor, current, receipts, invoices } = value;
  if (!allowed(actor, 'buyer', current.groupId) || actor.id !== current.ownerId) return failure('Denied');
  if (current.id !== input.id || [...receipts, ...invoices].some(row => row.groupId !== current.groupId || row.orderId !== current.id)) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'placed') return failure('WrongState');
  return ok(current);
}
// Commercial amounts remain those authorized in the approved request; only supplier can be amended.
export function amendOrder(value: Loaded<AmendInput, Order> & OrderFacts): Result<Change<Order>, RuleError> {
  const checked = orderGuard(value); if (!checked.ok) return checked;
  if (value.receipts.length || value.invoices.length) return failure('WrongState');
  if (typeof value.input.supplier !== 'string' || !value.input.supplier.trim()) return failure('InvalidInput');
  return ok(plan({ ...checked.value, supplier: value.input.supplier.trim(), version: checked.value.version + 1 }, [check(checked.value)]));
}
export function cancelOrder(value: Loaded<VersionInput, Order> & OrderFacts): Result<Change<Order>, RuleError> {
  const checked = orderGuard(value); if (!checked.ok) return checked;
  if (value.receipts.length || value.invoices.length) return failure('WrongState');
  return ok(plan({ ...checked.value, state: 'cancelled', version: checked.value.version + 1 }, [check(checked.value)]));
}
export function completeOrder(value: Loaded<VersionInput, Order> & OrderFacts): Result<Change<Order>, RuleError> {
  const checked = orderGuard(value); if (!checked.ok) return checked;
  const current = checked.value;
  if (value.invoices.length !== 1 || (value.invoices[0]?.state !== 'matched' && value.invoices[0]?.state !== 'approved') || value.invoices[0].amountCents !== current.totalCents || current.lines.some(line => value.receipts.filter(receipt => receipt.state === 'accepted').flatMap(receipt => receipt.quantities).filter(item => item.sku === line.sku).reduce((sum, item) => sum + item.quantity, 0) !== line.quantity)) return failure('InvoiceMismatch');
  return ok(plan({ ...current, state: 'completed', version: current.version + 1 }, [check(current), ...value.invoices.map(check)]));
}

function invoiceGuard(value: Loaded<VersionInput, Invoice> & Readonly<{ order: Order }>): Result<Invoice, RuleError> {
  const { input, actor, current, order } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (input.id !== current.id || order.id !== current.orderId || order.groupId !== current.groupId) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  return ok(current);
}
export function approveInvoice(value: Loaded<VersionInput, Invoice> & Readonly<{ order: Order }>): Result<Change<Invoice>, RuleError> {
  const checked = invoiceGuard(value); if (!checked.ok) return checked;
  const current = checked.value;
  if (current.state !== 'matched' || value.order.state === 'cancelled') return failure('WrongState');
  return ok(plan({ ...current, state: 'approved', approvedBy: value.actor.id, version: current.version + 1 }, [check(current), check(value.order)]));
}
export function voidInvoice(value: Loaded<ReasonInput, Invoice> & Readonly<{ order: Order }>): Result<Change<Invoice>, RuleError> {
  const checked = invoiceGuard(value); if (!checked.ok) return checked;
  const current = checked.value, order = value.order;
  if ((current.state !== 'registered' && current.state !== 'matched') || order.state !== 'placed') return failure('WrongState');
  if (typeof value.input.reason !== 'string' || !value.input.reason.trim() || value.input.reason.trim().length > 1000) return failure('InvalidInput');
  const result: Invoice = { kind: 'invoice', state: 'voided', id: current.id, groupId: current.groupId, orderId: current.orderId,
    amountCents: current.amountCents, version: current.version + 1, reason: value.input.reason.trim(), voidedBy: value.actor.id };
  return ok(plan(result, [check(current), check(order)], [{ ...order, version: order.version + 1 }, result]));
}

export function recordPayment(value: Loaded<PaymentInput, Invoice> & Readonly<{ alreadyRecorded: boolean }>): Result<Change<Payment>, RuleError> {
  const { input, actor, current } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (input.id !== current.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  if (current.state !== 'approved') return failure('WrongState');
  if (!id(input.paymentId) || !id(input.reference) || input.reference.length > 200) return failure('InvalidInput');
  if (value.alreadyRecorded) return failure('AlreadyExists');
  const result: Payment = { kind: 'payment', state: 'recorded', id: input.paymentId, groupId: current.groupId, version: 1,
    invoiceId: current.id, amountCents: current.amountCents, reference: input.reference, recordedBy: actor.id };
  return ok(plan(result, [check(current), absent('payment', current.groupId, result.id)]));
}
export function cancelPayment(value: Loaded<ReasonInput, Payment>): Result<Change<Payment>, RuleError> {
  const { input, actor, current } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (input.id !== current.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  if (current.state !== 'recorded') return failure('WrongState');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000) return failure('InvalidInput');
  return ok(plan({ ...current, state: 'cancelled', reason: input.reason.trim(), cancelledBy: actor.id, version: current.version + 1 }, [check(current)]));
}

export type ReceiptFacts = Readonly<{ order: Order; receipts: readonly Receipt[]; invoices: readonly Invoice[] }>;
function receiptGuard(value: Loaded<VersionInput, Receipt> & ReceiptFacts): Result<Receipt, RuleError> {
  const { input, actor, current, order, receipts, invoices } = value;
  if (!allowed(actor, 'warehouse', current.groupId)) return failure('Denied');
  if (input.id !== current.id || order.id !== current.orderId || order.groupId !== current.groupId || [...receipts, ...invoices].some(row => row.groupId !== current.groupId || row.orderId !== order.id)) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  if (current.state !== 'accepted' || order.state !== 'placed' || invoices.some(invoice => invoice.state === 'approved')) return failure('WrongState');
  return ok(current);
}
function receiptChange(result: Receipt, current: Receipt, facts: ReceiptFacts): Change<Receipt> {
  const reset: Invoice[] = facts.invoices.filter(invoice => invoice.state === 'matched').map(invoice => ({ kind: 'invoice', state: 'registered',
    id: invoice.id, groupId: invoice.groupId, orderId: invoice.orderId, amountCents: invoice.amountCents, version: invoice.version + 1 }));
  return plan(result, [check(current), check(facts.order), ...facts.invoices.map(check)],
    [{ ...facts.order, version: facts.order.version + 1 }, result, ...reset]);
}
export function returnReceipt(value: Loaded<ReasonInput, Receipt> & ReceiptFacts): Result<Change<Receipt>, RuleError> {
  const checked = receiptGuard(value); if (!checked.ok) return checked;
  if (typeof value.input.reason !== 'string' || !value.input.reason.trim() || value.input.reason.trim().length > 1000) return failure('InvalidInput');
  return ok(receiptChange({ ...checked.value, state: 'returned', returnedBy: value.actor.id, reason: value.input.reason.trim(), version: checked.value.version + 1 }, checked.value, value));
}
export function correctReceipt(value: Loaded<CorrectInput, Receipt> & ReceiptFacts): Result<Change<Receipt>, RuleError> {
  const checked = receiptGuard(value); if (!checked.ok) return checked;
  // Use the same quantity rule as receiving, excluding the record being replaced.
  const parsed = receiveOrder({ input: { id: value.order.id, expectedVersion: value.order.version, receiptId: checked.value.id, quantities: value.input.quantities },
    actor: value.actor, current: value.order, receipts: value.receipts.filter(receipt => receipt.id !== checked.value.id) });
  if (!parsed.ok) return parsed;
  const result: Receipt = { ...parsed.value.result, version: checked.value.version + 1 };
  return ok(receiptChange(result, checked.value, value));
}
