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
export type Order = Base & Readonly<{ kind: 'order'; state: 'placed'; requestId: string; ownerId: string; supplier: string; lines: readonly Line[]; totalCents: number }>;
export type Receipt = Base & Readonly<{ kind: 'receipt'; state: 'accepted'; orderId: string; quantities: readonly Quantity[] }>;
type InvoiceBase = Base & Readonly<{ kind: 'invoice'; orderId: string; amountCents: number }>;
export type Invoice = InvoiceBase & (Readonly<{ state: 'registered' }> | Readonly<{ state: 'matched'; receiptIds: readonly string[] }>);
export type Entity = Request | Order | Receipt | Invoice;
export type Check = Readonly<{ kind: Entity['kind']; id: string; groupId: string; version: number | null }>;
export type Change<T extends Entity> = Readonly<{ result: T; writes: readonly Entity[]; checks: readonly Check[] }>;
export type RuleError = Readonly<{ kind: 'Denied' | 'InvalidInput' | 'WrongState' | 'Conflict' | 'BudgetExceeded' | 'AlreadyExists' | 'QuantityExceeded' | 'InvoiceMismatch' | 'TargetMismatch' }>;
export type CreateInput = Readonly<{ id: string; lines: unknown }>;
export type VersionInput = Readonly<{ id: string; expectedVersion: number }>;
export type EditInput = VersionInput & Readonly<{ lines: unknown }>;
export type ReasonInput = VersionInput & Readonly<{ reason: string }>;
export type SubmitInput = VersionInput & Readonly<{ approverId: string }>;
export type PlaceInput = VersionInput & Readonly<{ orderId: string; supplier: string }>;
export type ReceiveInput = VersionInput & Readonly<{ receiptId: string; quantities: unknown }>;
export type RegisterInput = VersionInput & Readonly<{ invoiceId: string; amountCents: number }>;
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
  if (!id(input.receiptId) || !Array.isArray(input.quantities) || !input.quantities.length) return failure('InvalidInput');
  if (receipts.some(receipt => receipt.groupId !== current.groupId || receipt.orderId !== current.id)) return failure('TargetMismatch');
  const quantities: Quantity[] = [], seen = new Set<string>();
  for (const raw of input.quantities) {
    if (!raw || typeof raw !== 'object') return failure('InvalidInput');
    const row = raw as Record<string, unknown>;
    if (!id(row.sku) || typeof row.quantity !== 'number' || !integer(row.quantity) || seen.has(row.sku)) return failure('InvalidInput');
    const ordered = current.lines.find(line => line.sku === row.sku);
    const received = receipts.flatMap(receipt => receipt.quantities).filter(line => line.sku === row.sku).reduce((sum, line) => sum + line.quantity, 0);
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
  if (!id(input.invoiceId) || !integer(input.amountCents)) return failure('InvalidInput');
  if (value.alreadyInvoiced) return failure('AlreadyExists');
  const invoice: Invoice = { kind: 'invoice', state: 'registered', id: input.invoiceId, groupId: current.groupId, orderId: current.id, version: 1, amountCents: input.amountCents };
  return ok(plan(invoice, [check(current), absent('invoice', current.groupId, invoice.id)]));
}
export function matchInvoice(value: Loaded<VersionInput, Invoice> & Readonly<{ order: Order; receipts: readonly Receipt[] }>): Result<Change<Invoice>, RuleError> {
  const { input, actor, current, order, receipts } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'registered') return failure('WrongState');
  if (order.id !== current.orderId || order.groupId !== current.groupId || receipts.some(receipt => receipt.orderId !== order.id || receipt.groupId !== current.groupId)) return failure('TargetMismatch');
  if (current.amountCents !== order.totalCents || order.lines.some(line => receipts.flatMap(receipt => receipt.quantities).filter(item => item.sku === line.sku).reduce((sum, item) => sum + item.quantity, 0) !== line.quantity)) return failure('InvoiceMismatch');
  return ok(plan({ ...current, state: 'matched', receiptIds: receipts.map(receipt => receipt.id), version: current.version + 1 }, [check(current), check(order)]));
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
