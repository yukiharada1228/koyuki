// Evaluation domain, not a specification of the lecture author's product.
import { ok, err, type Result } from '../../framework/index.js';
export type Actor = Readonly<{ id: string; groupId: string; role: 'buyer' | 'approver' | 'warehouse' | 'finance'; active: boolean }>;
export type ReceiptDepletion = 'receiving-only' | 'available-locations';
export type Policy = Readonly<{ receiptDepletion?: ReceiptDepletion; requestLimitCents: number; approverIds: readonly string[]; secondApproval?: Readonly<{ aboveCents: number; approverId: string }> }>;
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
export type FirstReview = RequestBase & Readonly<{ state: 'first-review'; approverId: string; finalApproverId: string }> & Opaque<'request-first-review'>;
export type FinalReview = RequestBase & Readonly<{ state: 'final-review'; approverId: string; firstApprovedBy: string }> & Opaque<'request-final-review'>;
export type PendingApproval = Submitted | FirstReview | FinalReview;
export type SingleApproved = RequestBase & Readonly<{ state: 'approved'; approverId: string; approvedBy: string; approval?: never; firstApprovedBy?: never }> & Opaque<'request-approved'>;
export type DualApproved = RequestBase & Readonly<{ state: 'approved'; approval: 'dual'; approverId: string; approvedBy: string; firstApprovedBy: string }> & Opaque<'request-dual-approved'>;
export type Approved = SingleApproved | DualApproved;
export type Rejected = RequestBase & Readonly<{ state: 'rejected'; rejectedBy: string; reason: string }> & Opaque<'request-rejected'>;
export type Request = Draft | PendingApproval | Approved | Rejected;
const pendingApproval = (current: Request): current is PendingApproval => current.state === 'submitted' || current.state === 'first-review' || current.state === 'final-review';
type OrderBase = Base & Readonly<{ kind: 'order'; requestId: string; ownerId: string; supplier: string; lines: readonly Line[]; totalCents: number }>;
export type Order = OrderBase & (Readonly<{ state: 'placed' }> | Readonly<{ state: 'cancelled' }> | Readonly<{ state: 'completed' }>);
type ReceiptBase = Base & Readonly<{ kind: 'receipt'; orderId: string; quantities: readonly Quantity[] }>;
export type Receipt = ReceiptBase & (Readonly<{ state: 'accepted' }> | Readonly<{ state: 'returned'; reason: string; returnedBy: string }>);
type InvoiceBase = Base & Readonly<{ kind: 'invoice'; orderId: string; amountCents: number }>;
export type Invoice = InvoiceBase & (Readonly<{ state: 'registered' }> | Readonly<{ state: 'matched'; receiptIds: readonly string[] }> | Readonly<{ state: 'approved'; receiptIds: readonly string[]; approvedBy: string }> | Readonly<{ state: 'voided'; reason: string; voidedBy: string }>);
type PaymentBase = Base & Readonly<{ kind: 'payment'; invoiceId: string; amountCents: number; reference: string; recordedBy: string }>;
export type Payment = PaymentBase & (Readonly<{ state: 'recorded' }> | Readonly<{ state: 'cancelled'; reason: string; cancelledBy: string }>);
export type Position = Readonly<{ sku: string; location: string; onHand: number; reserved: number }>;
export type Stock = Base & Readonly<{ kind: 'stock'; positions: readonly Position[]; lastAdjustment: Readonly<{ reason: string; by: string }> | null }>;
export type Entity = Request | Order | Receipt | Invoice | Payment | Stock;
export type Check = Readonly<{ kind: Entity['kind']; id: string; groupId: string; version: number | null }>;
export type Change<T extends Entity> = Readonly<{ result: T; writes: readonly Entity[]; checks: readonly Check[] }>;
export type RuleError = Readonly<{ kind: 'Denied' | 'InvalidInput' | 'WrongState' | 'Conflict' | 'BudgetExceeded' | 'AlreadyExists' | 'QuantityExceeded' | 'InvoiceMismatch' | 'TargetMismatch' | 'InsufficientStock' }>;
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
type RuleFailure<K extends RuleError['kind']> = Readonly<{ kind: K }>;
const failure = <K extends RuleError['kind']>(kind: K): Result<never, RuleFailure<K>> => err({ kind });
declare const parsedRequestLinesProof: unique symbol;
export type ParsedRequestLines = readonly Line[] & Readonly<{ [parsedRequestLinesProof]: true }>;
export function parseRequestLines(value: unknown) {
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
  return ok(Object.freeze(parsed) as ParsedRequestLines);
}
const lines = parseRequestLines;
type RequestCreation = Readonly<{ input: CreateInput; actor: Actor }>;
declare const requestCreationProof: unique symbol;
export type CheckedRequestCreation = RequestCreation & Readonly<{ [requestCreationProof]: true }>;
export function checkRequestCreation(value: RequestCreation) {
  const { input, actor } = value;
  if (!allowed(actor, 'buyer', actor.groupId)) return failure('Denied');
  if (!id(input.id)) return failure('InvalidInput');
  return ok(value as CheckedRequestCreation);
}
export function requestCreationPlan(value: CheckedRequestCreation, parsed: ParsedRequestLines): Change<Draft> {
  const { input, actor } = value;
  const result: Draft = stamp('request-draft', { kind: 'request', state: 'draft', id: input.id, groupId: actor.groupId, ownerId: actor.id, version: 1,
    lines: parsed, totalCents: parsed.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) });
  return plan(result, [absent('request', actor.groupId, input.id)]);
}
export function createRequest(value: RequestCreation) {
  const checked = checkRequestCreation(value); if (!checked.ok) return checked;
  const parsed = lines(value.input.lines); if (!parsed.ok) return parsed;
  return ok(requestCreationPlan(checked.value, parsed.value));
}
export function submitRequest(value: Loaded<SubmitInput, Request> & Readonly<{ policy: Policy }>) {
  const checked = checkBuyerRequest(value); if (!checked.ok) return checked;
  return submitCheckedRequest(checked.value);
}
export function submitCheckedRequest(value: CheckedRequest<Loaded<SubmitInput, Request> & Readonly<{ policy: Policy }>, 'buyer'>) {
  const { input, current, policy } = value;
  if (current.state !== 'draft') return failure('WrongState');
  if (!id(input.approverId) || !policy.approverIds.includes(input.approverId) || input.approverId === current.ownerId) return failure('InvalidInput');
  if (!integer(policy.requestLimitCents) || current.totalCents > policy.requestLimitCents) return failure('BudgetExceeded');
  const second = policy.secondApproval;
  if (second !== undefined) {
    if (!Number.isSafeInteger(second.aboveCents) || second.aboveCents < 0 || !id(second.approverId) || !policy.approverIds.includes(second.approverId)) return failure('InvalidInput');
    if (current.totalCents > second.aboveCents) {
      if (second.approverId === current.ownerId || second.approverId === input.approverId) return failure('InvalidInput');
      return ok<Change<Submitted | FirstReview>>(plan(stamp('request-first-review', { ...current, state: 'first-review', approverId: input.approverId,
        finalApproverId: second.approverId, version: current.version + 1 }), [check(current)]));
    }
  }
  return ok<Change<Submitted | FirstReview>>(plan(stamp('request-submitted', { ...current, state: 'submitted', approverId: input.approverId, version: current.version + 1 }), [check(current)]));
}
export function approveRequest(value: Loaded<VersionInput, Request>) {
  const checked = checkApproverRequest(value); if (!checked.ok) return checked;
  return approveCheckedRequest(checked.value);
}
export function approveCheckedRequest(value: CheckedRequest<Loaded<VersionInput, Request>, 'approver'>) {
  const { actor, current } = value;
  if (!pendingApproval(current)) return failure('WrongState');
  if (current.state === 'first-review') {
    const { finalApproverId, ...base } = current;
    return ok<Change<Approved | FinalReview>>(plan(stamp('request-final-review', { ...base, state: 'final-review', approverId: finalApproverId,
      firstApprovedBy: actor.id, version: current.version + 1 }), [check(current)]));
  }
  if (current.state === 'final-review') {
    if (actor.id === current.firstApprovedBy) return failure('Denied');
    return ok<Change<Approved | FinalReview>>(plan(stamp('request-dual-approved', { ...current, state: 'approved', approval: 'dual', approvedBy: actor.id,
      version: current.version + 1 }), [check(current)]));
  }
  return ok<Change<Approved | FinalReview>>(plan(stamp('request-approved', { ...current, state: 'approved', approvedBy: actor.id, version: current.version + 1 }), [check(current)]));
}
export function placeOrder(value: Loaded<PlaceInput, Request> & Readonly<{ alreadyOrdered: boolean }>) {
  const checked = checkBuyerRequest(value); if (!checked.ok) return checked;
  return placeCheckedOrder(checked.value);
}
export function placeCheckedOrder(value: CheckedRequest<Loaded<PlaceInput, Request> & Readonly<{ alreadyOrdered: boolean }>, 'buyer'>) {
  const { input, current } = value;
  if (current.state !== 'approved') return failure('WrongState');
  if (!id(input.orderId) || typeof input.supplier !== 'string' || !input.supplier.trim()) return failure('InvalidInput');
  if (value.alreadyOrdered) return failure('AlreadyExists');
  const order: Order = { kind: 'order', state: 'placed', id: input.orderId, groupId: current.groupId, version: 1,
    requestId: current.id, ownerId: current.ownerId, supplier: input.supplier.trim(), lines: current.lines, totalCents: current.totalCents };
  return ok<Change<Extract<Order, { readonly state: 'placed' }>>>(plan(order, [check(current), absent('order', current.groupId, order.id)]));
}
declare const receivedCheck: unique symbol;
export type ReceivedChange = Change<Extract<Receipt, { readonly state: 'accepted' }>> & Readonly<{ [receivedCheck]: true }>;
export function receiveOrder<T extends Loaded<ReceiveInput, Order> & Readonly<{ receipts: readonly Receipt[] }>>(value: T): Result<ReceivedChange, RuleError> {
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
  return ok(plan(receipt, [check(current), absent('receipt', current.groupId, receipt.id)], [{ ...current, version: current.version + 1 }, receipt]) as ReceivedChange);
}
declare const financeTransitionProof: unique symbol;
type InvoiceRegistration = Loaded<RegisterInput, Order> & Readonly<{ alreadyInvoiced: boolean }>;
export type CheckedInvoiceRegistration<T extends InvoiceRegistration = InvoiceRegistration> = T & Readonly<{ current: Extract<Order, { readonly state: 'placed' }>; [financeTransitionProof]: 'register-invoice'; alreadyInvoiced: false }>;
export function checkInvoiceRegistration<T extends InvoiceRegistration>(value: T) {
  const { input, actor, current } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'placed') return failure('WrongState');
  if (!id(input.invoiceId) || !integer(input.amountCents)) return failure('InvalidInput');
  if (value.alreadyInvoiced) return failure('AlreadyExists');
  return ok(value as CheckedInvoiceRegistration<T>);
}
export function registerCheckedInvoice(value: CheckedInvoiceRegistration): Result<Change<Extract<Invoice, { readonly state: 'registered' }>>, never> {
  const { input, current } = value;
  const invoice: Invoice = { kind: 'invoice', state: 'registered', id: input.invoiceId, groupId: current.groupId, orderId: current.id, version: 1, amountCents: input.amountCents };
  return ok(plan(invoice, [check(current), absent('invoice', current.groupId, invoice.id)], [{ ...current, version: current.version + 1 }, invoice]));
}
export function registerInvoice(value: InvoiceRegistration) {
  const checked = checkInvoiceRegistration(value); if (!checked.ok) return checked;
  return registerCheckedInvoice(checked.value);
}
type InvoiceMatching = Loaded<VersionInput, Invoice> & Readonly<{ order: Order; receipts: readonly Receipt[] }>;
export type CheckedInvoiceMatching<T extends InvoiceMatching = InvoiceMatching> = T & Readonly<{ current: Extract<Invoice, { readonly state: 'registered' }>; [financeTransitionProof]: 'match-invoice' }>;
export function checkInvoiceMatching<T extends InvoiceMatching>(value: T) {
  const { input, actor, current, order, receipts } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'registered') return failure('WrongState');
  if (order.id !== current.orderId || order.groupId !== current.groupId || receipts.some(receipt => receipt.orderId !== order.id || receipt.groupId !== current.groupId)) return failure('TargetMismatch');
  if (current.amountCents !== order.totalCents || order.lines.some(line => receipts.filter(receipt => receipt.state === 'accepted').flatMap(receipt => receipt.quantities).filter(item => item.sku === line.sku).reduce((sum, item) => sum + item.quantity, 0) !== line.quantity)) return failure('InvoiceMismatch');
  return ok(value as CheckedInvoiceMatching<T>);
}
export function matchCheckedInvoice(value: CheckedInvoiceMatching): Result<Change<Extract<Invoice, { readonly state: 'matched' }>>, never> {
  const { current, order, receipts } = value;
  return ok(plan({ ...current, state: 'matched', receiptIds: receipts.filter(receipt => receipt.state === 'accepted').map(receipt => receipt.id), version: current.version + 1 }, [check(current), check(order)]));
}
export function matchInvoice(value: InvoiceMatching) {
  const checked = checkInvoiceMatching(value); if (!checked.ok) return checked;
  return matchCheckedInvoice(checked.value);
}

// Shared checks describe this domain's ownership and version rules, not runtime orchestration.
declare const requestCheck: unique symbol;
export type CheckedRequest<T, R extends 'buyer' | 'approver'> = T & Readonly<{ [requestCheck]: R }>;
function checkRequest<T extends Loaded<VersionInput, Request>, R extends 'buyer' | 'approver'>(value: T, role: R) {
  const { input, actor, current } = value;
  if (!allowed(actor, role, current.groupId) || (role === 'buyer' ? actor.id !== current.ownerId : actor.id === current.ownerId)) return failure('Denied');
  if (current.id !== input.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (role === 'approver' && pendingApproval(current) && current.approverId !== actor.id) return failure('Denied');
  return ok(value as CheckedRequest<T, R>);
}
export const checkBuyerRequest = <T extends Loaded<VersionInput, Request>>(value: T) => checkRequest(value, 'buyer');
export const checkApproverRequest = <T extends Loaded<VersionInput, Request>>(value: T) => checkRequest(value, 'approver');

function draftFrom(current: Request): Draft {
  return stamp('request-draft', { kind: 'request', state: 'draft', id: current.id, groupId: current.groupId,
    ownerId: current.ownerId, lines: current.lines, totalCents: current.totalCents, version: current.version + 1 });
}
export function editRequest(value: Loaded<EditInput, Request>) {
  const checked = checkBuyerRequest(value); if (!checked.ok) return checked;
  return editCheckedRequest(checked.value);
}
export function editCheckedRequest(value: CheckedRequest<Loaded<EditInput, Request>, 'buyer'>) {
  const checked = checkRequestEdit(value); if (!checked.ok) return checked;
  const parsed = lines(value.input.lines); if (!parsed.ok) return parsed;
  return ok(requestEditPlan(checked.value, parsed.value));
}
export type EditableRequest = CheckedRequest<Loaded<EditInput, Draft>, 'buyer'>;
export function checkRequestEdit(value: CheckedRequest<Loaded<EditInput, Request>, 'buyer'>) {
  if (value.current.state !== 'draft') return failure('WrongState');
  return ok(value as EditableRequest);
}
export function requestEditPlan(value: EditableRequest, parsed: ParsedRequestLines): Change<Draft> {
  const result: Draft = { ...draftFrom(value.current), lines: parsed, totalCents: parsed.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) };
  return plan(result, [check(value.current)]);
}
export function withdrawRequest(value: Loaded<VersionInput, Request>) {
  const checked = checkBuyerRequest(value); if (!checked.ok) return checked;
  return withdrawCheckedRequest(checked.value);
}
export function withdrawCheckedRequest(value: CheckedRequest<Loaded<VersionInput, Request>, 'buyer'>) {
  if (!pendingApproval(value.current)) return failure('WrongState');
  return ok<Change<Draft>>(plan(draftFrom(value.current), [check(value.current)]));
}
export function rejectRequest(value: Loaded<ReasonInput, Request>) {
  const checked = checkApproverRequest(value); if (!checked.ok) return checked;
  return rejectCheckedRequest(checked.value);
}
export function rejectCheckedRequest(value: CheckedRequest<Loaded<ReasonInput, Request>, 'approver'>) {
  const current = value.current;
  if (!pendingApproval(current)) return failure('WrongState');
  if (typeof value.input.reason !== 'string' || !value.input.reason.trim() || value.input.reason.trim().length > 1000) return failure('InvalidInput');
  const result: Rejected = stamp('request-rejected', { kind: 'request', state: 'rejected', id: current.id, groupId: current.groupId,
    ownerId: current.ownerId, lines: current.lines, totalCents: current.totalCents, version: current.version + 1,
    rejectedBy: value.actor.id, reason: value.input.reason.trim() });
  return ok<Change<Rejected>>(plan(result, [check(current)]));
}
export function returnRequest(value: Loaded<VersionInput, Request>) {
  const checked = checkApproverRequest(value); if (!checked.ok) return checked;
  return returnCheckedRequest(checked.value);
}
export function returnCheckedRequest(value: CheckedRequest<Loaded<VersionInput, Request>, 'approver'>) {
  if (!pendingApproval(value.current)) return failure('WrongState');
  return ok<Change<Draft>>(plan(draftFrom(value.current), [check(value.current)]));
}
export function reassignRequest(value: Loaded<SubmitInput, Request> & Readonly<{ policy: Policy }>) {
  const checked = checkApproverRequest(value); if (!checked.ok) return checked;
  return reassignCheckedRequest(checked.value);
}
export function reassignCheckedRequest(value: CheckedRequest<Loaded<SubmitInput, Request> & Readonly<{ policy: Policy }>, 'approver'>) {
  const current = value.current, next = value.input.approverId;
  if (!pendingApproval(current)) return failure('WrongState');
  if (!id(next) || next === current.ownerId || next === current.approverId || !value.policy.approverIds.includes(next)) return failure('InvalidInput');
  if (current.state === 'first-review') {
    if (next === current.finalApproverId) return failure('InvalidInput');
    return ok<Change<PendingApproval>>(plan(stamp('request-first-review', { ...current, approverId: next, version: current.version + 1 }), [check(current)]));
  }
  if (current.state === 'final-review') {
    if (next === current.firstApprovedBy) return failure('InvalidInput');
    return ok<Change<PendingApproval>>(plan(stamp('request-final-review', { ...current, approverId: next, version: current.version + 1 }), [check(current)]));
  }
  return ok<Change<PendingApproval>>(plan(stamp('request-submitted', { ...current, approverId: next, version: current.version + 1 }), [check(current)]));
}

export type OrderFacts = Readonly<{ receipts: readonly Receipt[]; invoices: readonly Invoice[] }>;
declare const orderCheck: unique symbol;
export type CheckedOrder<T> = T & Readonly<{ current: Extract<Order, { state: 'placed' }>; [orderCheck]: true }>;
export function checkOrder<T extends Loaded<VersionInput, Order> & OrderFacts>(value: T) {
  const { input, actor, current, receipts, invoices } = value;
  if (!allowed(actor, 'buyer', current.groupId) || actor.id !== current.ownerId) return failure('Denied');
  if (current.id !== input.id || [...receipts, ...invoices].some(row => row.groupId !== current.groupId || row.orderId !== current.id)) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (current.version !== input.expectedVersion) return failure('Conflict');
  if (current.state !== 'placed') return failure('WrongState');
  // Private compile-time proof over the same readonly loaded context.
  return ok(value as CheckedOrder<T>);
}
// Commercial amounts remain those authorized in the approved request; only supplier can be amended.
export function amendOrder(value: Loaded<AmendInput, Order> & OrderFacts) {
  const checked = checkOrder(value); if (!checked.ok) return checked;
  return amendCheckedOrder(checked.value);
}
export function amendCheckedOrder(value: CheckedOrder<Loaded<AmendInput, Order> & OrderFacts>) {
  if (value.receipts.length || value.invoices.length) return failure('WrongState');
  if (typeof value.input.supplier !== 'string' || !value.input.supplier.trim()) return failure('InvalidInput');
  return ok<Change<Extract<Order, { readonly state: 'placed' }>>>(plan({ ...value.current, supplier: value.input.supplier.trim(), version: value.current.version + 1 }, [check(value.current)]));
}
export function cancelOrder(value: Loaded<VersionInput, Order> & OrderFacts) {
  const checked = checkOrder(value); if (!checked.ok) return checked;
  return cancelCheckedOrder(checked.value);
}
export function cancelCheckedOrder(value: CheckedOrder<Loaded<VersionInput, Order> & OrderFacts>) {
  if (value.receipts.length || value.invoices.length) return failure('WrongState');
  return ok<Change<Extract<Order, { readonly state: 'cancelled' }>>>(plan({ ...value.current, state: 'cancelled', version: value.current.version + 1 }, [check(value.current)]));
}
export function completeOrder(value: Loaded<VersionInput, Order> & OrderFacts) {
  const checked = checkOrder(value); if (!checked.ok) return checked;
  return completeCheckedOrder(checked.value);
}
export function completeCheckedOrder(value: CheckedOrder<Loaded<VersionInput, Order> & OrderFacts>) {
  const current = value.current;
  if (value.invoices.length !== 1 || (value.invoices[0]?.state !== 'matched' && value.invoices[0]?.state !== 'approved') || value.invoices[0].amountCents !== current.totalCents || current.lines.some(line => value.receipts.filter(receipt => receipt.state === 'accepted').flatMap(receipt => receipt.quantities).filter(item => item.sku === line.sku).reduce((sum, item) => sum + item.quantity, 0) !== line.quantity)) return failure('InvoiceMismatch');
  return ok<Change<Extract<Order, { readonly state: 'completed' }>>>(plan({ ...current, state: 'completed', version: current.version + 1 }, [check(current), ...value.invoices.map(check)]));
}

declare const invoiceCheck: unique symbol;
export type CheckedInvoice<T> = T & Readonly<{ [invoiceCheck]: true }>;
export function checkInvoice<T extends Loaded<VersionInput, Invoice> & Readonly<{ order: Order }>>(value: T) {
  const { input, actor, current, order } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (input.id !== current.id || order.id !== current.orderId || order.groupId !== current.groupId) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  return ok(value as CheckedInvoice<T>);
}
export function approveInvoice(value: Loaded<VersionInput, Invoice> & Readonly<{ order: Order }>) {
  const checked = checkInvoice(value); if (!checked.ok) return checked;
  return approveCheckedInvoice(checked.value);
}
export function approveCheckedInvoice(value: CheckedInvoice<Loaded<VersionInput, Invoice> & Readonly<{ order: Order }>>): Result<Change<Extract<Invoice, { readonly state: 'approved' }>>, RuleFailure<'WrongState'>> {
  const current = value.current;
  if (current.state !== 'matched' || value.order.state === 'cancelled') return failure('WrongState');
  return ok(plan({ ...current, state: 'approved', approvedBy: value.actor.id, version: current.version + 1 }, [check(current), check(value.order)]));
}
export function voidInvoice(value: Loaded<ReasonInput, Invoice> & Readonly<{ order: Order }>) {
  const checked = checkInvoice(value); if (!checked.ok) return checked;
  return voidCheckedInvoice(checked.value);
}
export function voidCheckedInvoice(value: CheckedInvoice<Loaded<ReasonInput, Invoice> & Readonly<{ order: Order }>>): Result<Change<Extract<Invoice, { readonly state: 'voided' }>>, RuleFailure<'WrongState' | 'InvalidInput'>> {
  const current = value.current, order = value.order;
  if ((current.state !== 'registered' && current.state !== 'matched') || order.state !== 'placed') return failure('WrongState');
  if (typeof value.input.reason !== 'string' || !value.input.reason.trim() || value.input.reason.trim().length > 1000) return failure('InvalidInput');
  const result: Invoice = { kind: 'invoice', state: 'voided', id: current.id, groupId: current.groupId, orderId: current.orderId,
    amountCents: current.amountCents, version: current.version + 1, reason: value.input.reason.trim(), voidedBy: value.actor.id };
  return ok(plan(result, [check(current), check(order)], [{ ...order, version: order.version + 1 }, result]));
}

type PaymentRecording = Loaded<PaymentInput, Invoice> & Readonly<{ alreadyRecorded: boolean }>;
export type CheckedPaymentRecording<T extends PaymentRecording = PaymentRecording> = T & Readonly<{ current: Extract<Invoice, { readonly state: 'approved' }>; [financeTransitionProof]: 'record-payment'; alreadyRecorded: false }>;
export function checkPaymentRecording<T extends PaymentRecording>(value: T) {
  const { input, actor, current } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (input.id !== current.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  if (current.state !== 'approved') return failure('WrongState');
  if (!id(input.paymentId) || !id(input.reference) || input.reference.length > 200) return failure('InvalidInput');
  if (value.alreadyRecorded) return failure('AlreadyExists');
  return ok(value as CheckedPaymentRecording<T>);
}
export function recordCheckedPayment(value: CheckedPaymentRecording): Result<Change<Extract<Payment, { readonly state: 'recorded' }>>, never> {
  const { input, actor, current } = value;
  const result: Payment = { kind: 'payment', state: 'recorded', id: input.paymentId, groupId: current.groupId, version: 1,
    invoiceId: current.id, amountCents: current.amountCents, reference: input.reference, recordedBy: actor.id };
  return ok(plan(result, [check(current), absent('payment', current.groupId, result.id)]));
}
export function recordPayment(value: PaymentRecording) {
  const checked = checkPaymentRecording(value); if (!checked.ok) return checked;
  return recordCheckedPayment(checked.value);
}
type PaymentCancellation = Loaded<ReasonInput, Payment>;
export type CheckedPaymentCancellation<T extends PaymentCancellation = PaymentCancellation> = T & Readonly<{ current: Extract<Payment, { readonly state: 'recorded' }>; [financeTransitionProof]: 'cancel-payment' }>;
export function checkPaymentCancellation<T extends PaymentCancellation>(value: T) {
  const { input, actor, current } = value;
  if (!allowed(actor, 'finance', current.groupId)) return failure('Denied');
  if (input.id !== current.id) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  if (current.state !== 'recorded') return failure('WrongState');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000) return failure('InvalidInput');
  return ok(value as CheckedPaymentCancellation<T>);
}
export function cancelCheckedPayment(value: CheckedPaymentCancellation): Result<Change<Extract<Payment, { readonly state: 'cancelled' }>>, never> {
  const { input, actor, current } = value;
  return ok(plan({ ...current, state: 'cancelled', reason: input.reason.trim(), cancelledBy: actor.id, version: current.version + 1 }, [check(current)]));
}
export function cancelPayment(value: PaymentCancellation) {
  const checked = checkPaymentCancellation(value); if (!checked.ok) return checked;
  return cancelCheckedPayment(checked.value);
}

export type ReceiptFacts = Readonly<{ order: Order; receipts: readonly Receipt[]; invoices: readonly Invoice[] }>;
declare const receiptCheck: unique symbol;
export type CheckedReceipt<T> = T & Readonly<{
  current: Extract<Receipt, { state: 'accepted' }>;
  order: Extract<Order, { state: 'placed' }>;
  [receiptCheck]: true;
}>;
export function checkReceipt<T extends Loaded<VersionInput, Receipt> & ReceiptFacts>(value: T): Result<CheckedReceipt<T>, RuleError> {
  const { input, actor, current, order, receipts, invoices } = value;
  if (!allowed(actor, 'warehouse', current.groupId)) return failure('Denied');
  if (input.id !== current.id || order.id !== current.orderId || order.groupId !== current.groupId || [...receipts, ...invoices].some(row => row.groupId !== current.groupId || row.orderId !== order.id)) return failure('TargetMismatch');
  if (!integer(input.expectedVersion)) return failure('InvalidInput');
  if (input.expectedVersion !== current.version) return failure('Conflict');
  if (current.state !== 'accepted' || order.state !== 'placed' || invoices.some(invoice => invoice.state === 'approved')) return failure('WrongState');
  return ok(value as CheckedReceipt<T>);
}
function receiptChange<T extends Receipt>(result: T, current: Receipt, facts: ReceiptFacts): Change<T> {
  const reset: Invoice[] = facts.invoices.filter(invoice => invoice.state === 'matched').map(invoice => ({ kind: 'invoice', state: 'registered',
    id: invoice.id, groupId: invoice.groupId, orderId: invoice.orderId, amountCents: invoice.amountCents, version: invoice.version + 1 }));
  return plan(result, [check(current), check(facts.order), ...facts.invoices.map(check)],
    [{ ...facts.order, version: facts.order.version + 1 }, result, ...reset]);
}
export function returnReceipt(value: Loaded<ReasonInput, Receipt> & ReceiptFacts): Result<Change<Extract<Receipt, { readonly state: 'returned' }>>, RuleError> {
  const checked = checkReceipt(value); if (!checked.ok) return checked;
  return returnCheckedReceipt(checked.value);
}
export function returnCheckedReceipt<T extends CheckedReceipt<Loaded<ReasonInput, Receipt> & ReceiptFacts>>(value: T): Result<Change<Extract<Receipt, { readonly state: 'returned' }>>, RuleError> {
  if (typeof value.input.reason !== 'string' || !value.input.reason.trim() || value.input.reason.trim().length > 1000) return failure('InvalidInput');
  return ok(receiptChange({ ...value.current, state: 'returned', returnedBy: value.actor.id, reason: value.input.reason.trim(), version: value.current.version + 1 }, value.current, value));
}
export function correctReceipt(value: Loaded<CorrectInput, Receipt> & ReceiptFacts): Result<Change<Extract<Receipt, { readonly state: 'accepted' }>>, RuleError> {
  const checked = checkReceipt(value); if (!checked.ok) return checked;
  return correctCheckedReceipt(checked.value);
}
export function receiptCorrectionInput(value: CheckedReceipt<Loaded<CorrectInput, Receipt> & ReceiptFacts>): Loaded<ReceiveInput, Order> & Readonly<{ receipts: readonly Receipt[] }> {
  return { input: { id: value.order.id, expectedVersion: value.order.version, receiptId: value.current.id, quantities: value.input.quantities },
    actor: value.actor, current: value.order, receipts: value.receipts.filter(receipt => receipt.id !== value.current.id) };
}
// Matching context and validated receipt are connected by the declaration. The
// private producer proof is required by the projection's input contract.
export function finishReceiptCorrection(value: CheckedReceipt<Loaded<CorrectInput, Receipt> & ReceiptFacts>, received: ReceivedChange): Change<Extract<Receipt, { readonly state: 'accepted' }>> {
  const result: Receipt = { ...received.result, version: value.current.version + 1 };
  return receiptChange(result, value.current, value);
}
export function correctCheckedReceipt(value: CheckedReceipt<Loaded<CorrectInput, Receipt> & ReceiptFacts>): Result<Change<Extract<Receipt, { readonly state: 'accepted' }>>, RuleError> {
  const parsed = receiveOrder(receiptCorrectionInput(value));
  if (!parsed.ok) return parsed;
  return ok(finishReceiptCorrection(value, parsed.value));
}

/** Decode persisted values at the domain boundary; never restore proof by casting JSON. */
export function restoreEntity(value: unknown): Entity | null {
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const row = object(value); if (!row || !id(row.id) || !id(row.groupId) || typeof row.version !== 'number' || !integer(row.version)) return null;
  const base = { id: row.id, groupId: row.groupId, version: row.version };
  const exact = (...fields: string[]) => { const expected = ['kind', 'id', 'groupId', 'version', ...fields]; return Object.keys(row).length === expected.length && expected.every(field => Object.hasOwn(row, field)); };
  const reason = (value: unknown): value is string => id(value) && value.length <= 1000;
  const quantityRows = (value: unknown): readonly Quantity[] | null => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return null;
    const seen = new Set<string>(), result: Quantity[] = [];
    for (const raw of value) {
      const item = object(raw);
      if (!item || Object.keys(item).length !== 2 || !id(item.sku) || seen.has(item.sku) || typeof item.quantity !== 'number' || !integer(item.quantity)) return null;
      seen.add(item.sku); result.push(Object.freeze({ sku: item.sku, quantity: item.quantity }));
    }
    return Object.freeze(result);
  };
  if (row.kind === 'request' || row.kind === 'order') {
    if (!Array.isArray(row.lines) || row.lines.some(line => !object(line) || Object.keys(line).length !== 3)) return null;
    const parsed = lines(row.lines); if (!parsed.ok || row.totalCents !== parsed.value.reduce((sum, line) => sum + line.quantity * line.unitCents, 0) || !id(row.ownerId)) return null;
    const common = { ...base, ownerId: row.ownerId, lines: parsed.value, totalCents: row.totalCents };
    if (row.kind === 'order') {
      if (!exact('state', 'requestId', 'ownerId', 'supplier', 'lines', 'totalCents') || !id(row.requestId) || !id(row.supplier) || (row.state !== 'placed' && row.state !== 'cancelled' && row.state !== 'completed')) return null;
      return { ...common, kind: 'order', state: row.state, requestId: row.requestId, supplier: row.supplier };
    }
    const fields = ['state', 'ownerId', 'lines', 'totalCents'];
    if (row.state === 'draft' && exact(...fields)) return stamp('request-draft', { ...common, kind: 'request', state: 'draft' });
    if (row.state === 'submitted' && exact(...fields, 'approverId') && id(row.approverId) && row.approverId !== row.ownerId) return stamp('request-submitted', { ...common, kind: 'request', state: 'submitted', approverId: row.approverId });
    if (row.state === 'first-review' && row.version >= 2 && exact(...fields, 'approverId', 'finalApproverId') && id(row.approverId) && id(row.finalApproverId)
      && row.approverId !== row.ownerId && row.finalApproverId !== row.ownerId && row.approverId !== row.finalApproverId)
      return stamp('request-first-review', { ...common, kind: 'request', state: 'first-review', approverId: row.approverId, finalApproverId: row.finalApproverId });
    if (row.state === 'final-review' && row.version >= 3 && exact(...fields, 'approverId', 'firstApprovedBy') && id(row.approverId) && id(row.firstApprovedBy)
      && row.approverId !== row.ownerId && row.firstApprovedBy !== row.ownerId && row.approverId !== row.firstApprovedBy)
      return stamp('request-final-review', { ...common, kind: 'request', state: 'final-review', approverId: row.approverId, firstApprovedBy: row.firstApprovedBy });
    if (row.state === 'approved' && row.approval === 'dual' && row.version >= 4 && exact(...fields, 'approverId', 'approvedBy', 'approval', 'firstApprovedBy')
      && id(row.approverId) && id(row.firstApprovedBy) && row.approvedBy === row.approverId && row.approverId !== row.ownerId
      && row.firstApprovedBy !== row.ownerId && row.approverId !== row.firstApprovedBy)
      return stamp('request-dual-approved', { ...common, kind: 'request', state: 'approved', approval: 'dual', approverId: row.approverId,
        approvedBy: row.approverId, firstApprovedBy: row.firstApprovedBy });
    if (row.state === 'approved' && exact(...fields, 'approverId', 'approvedBy') && id(row.approverId) && row.approvedBy === row.approverId && row.approverId !== row.ownerId) return stamp('request-approved', { ...common, kind: 'request', state: 'approved', approverId: row.approverId, approvedBy: row.approverId });
    if (row.state === 'rejected' && exact(...fields, 'rejectedBy', 'reason') && id(row.rejectedBy) && row.rejectedBy !== row.ownerId && reason(row.reason)) return stamp('request-rejected', { ...common, kind: 'request', state: 'rejected', rejectedBy: row.rejectedBy, reason: row.reason });
    return null;
  }
  if (row.kind === 'receipt') {
    const quantities = quantityRows(row.quantities); if (!quantities || !id(row.orderId)) return null;
    const common = { ...base, kind: 'receipt' as const, orderId: row.orderId, quantities };
    if (row.state === 'accepted' && exact('state', 'orderId', 'quantities')) return { ...common, state: 'accepted' };
    if (row.state === 'returned' && exact('state', 'orderId', 'quantities', 'reason', 'returnedBy') && reason(row.reason) && id(row.returnedBy)) return { ...common, state: 'returned', reason: row.reason, returnedBy: row.returnedBy };
    return null;
  }
  if (row.kind === 'invoice') {
    if (!id(row.orderId) || typeof row.amountCents !== 'number' || !integer(row.amountCents)) return null;
    const common = { ...base, kind: 'invoice' as const, orderId: row.orderId, amountCents: row.amountCents };
    if (row.state === 'registered' && exact('state', 'orderId', 'amountCents')) return { ...common, state: 'registered' };
    if (row.state === 'voided' && exact('state', 'orderId', 'amountCents', 'reason', 'voidedBy') && reason(row.reason) && id(row.voidedBy)) return { ...common, state: 'voided', reason: row.reason, voidedBy: row.voidedBy };
    if (!Array.isArray(row.receiptIds) || !row.receiptIds.length || !Array.from(row.receiptIds).every(id) || new Set(row.receiptIds).size !== row.receiptIds.length) return null;
    const receiptIds: readonly string[] = Object.freeze([...row.receiptIds]);
    if (row.state === 'matched' && exact('state', 'orderId', 'amountCents', 'receiptIds')) return { ...common, state: 'matched', receiptIds };
    if (row.state === 'approved' && exact('state', 'orderId', 'amountCents', 'receiptIds', 'approvedBy') && id(row.approvedBy)) return { ...common, state: 'approved', receiptIds, approvedBy: row.approvedBy };
    return null;
  }
  if (row.kind === 'payment') {
    if (!id(row.invoiceId) || typeof row.amountCents !== 'number' || !integer(row.amountCents) || !id(row.reference) || row.reference.length > 200 || !id(row.recordedBy)) return null;
    const common = { ...base, kind: 'payment' as const, invoiceId: row.invoiceId, amountCents: row.amountCents, reference: row.reference, recordedBy: row.recordedBy };
    if (row.state === 'recorded' && exact('state', 'invoiceId', 'amountCents', 'reference', 'recordedBy')) return { ...common, state: 'recorded' };
    if (row.state === 'cancelled' && exact('state', 'invoiceId', 'amountCents', 'reference', 'recordedBy', 'reason', 'cancelledBy') && reason(row.reason) && id(row.cancelledBy)) return { ...common, state: 'cancelled', reason: row.reason, cancelledBy: row.cancelledBy };
    return null;
  }
  if (row.kind === 'stock') {
    if (row.id !== 'warehouse' || !exact('positions', 'lastAdjustment') || !Array.isArray(row.positions)) return null;
    const positions: Position[] = [], seen = new Set<string>();
    for (const raw of row.positions) {
      const item = object(raw);
      if (!item || Object.keys(item).length !== 4 || !id(item.sku) || !id(item.location) || typeof item.onHand !== 'number' || !Number.isSafeInteger(item.onHand) || item.onHand < 0 || typeof item.reserved !== 'number' || !Number.isSafeInteger(item.reserved) || item.reserved < 0 || item.reserved > item.onHand) return null;
      const key = JSON.stringify([item.sku, item.location]); if (seen.has(key)) return null; seen.add(key);
      positions.push(Object.freeze({ sku: item.sku, location: item.location, onHand: item.onHand, reserved: item.reserved }));
    }
    let lastAdjustment: Stock['lastAdjustment'] = null;
    if (row.lastAdjustment !== null) {
      const adjustment = object(row.lastAdjustment);
      if (!adjustment || Object.keys(adjustment).length !== 2 || !reason(adjustment.reason) || !id(adjustment.by)) return null;
      lastAdjustment = { reason: adjustment.reason, by: adjustment.by };
    }
    return { ...base, kind: 'stock', positions: Object.freeze(positions), lastAdjustment };
  }
  return null;
}
