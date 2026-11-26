import { ok, err, type Result } from '../../framework/index.js';
import { receiveOrder, returnReceipt, correctReceipt, type Actor, type Stock, type Position, type Change, type Receipt,
  type ReceiptDepletion, type VersionInput, type Loaded, type ReceiveInput, type ReasonInput, type CorrectInput, type Order, type ReceiptFacts, type RuleError } from './domain.js';
export const stockId = 'warehouse';
export type StockInput = Readonly<{ id: string; expectedVersion: number; sku: string; location: string; quantity: number }>;
export type MoveInput = StockInput & Readonly<{ destination: string }>;
export type AdjustInput = StockInput & Readonly<{ reason: string }>;
type Context<I> = Readonly<{ input: I; actor: Actor; stock: Stock | null }>;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const fail = <K extends RuleError['kind']>(kind: K): Result<never, Readonly<{ kind: K }>> => err({ kind });
function stockPlan(stock: Stock | null, actor: Actor, positions: readonly Position[], lastAdjustment = stock?.lastAdjustment ?? null): Change<Stock> {
  const result: Stock = { kind: 'stock', id: stockId, groupId: actor.groupId, version: (stock?.version ?? 0) + 1, positions, lastAdjustment };
  return { result, writes: [result], checks: [{ kind: 'stock', id: stockId, groupId: actor.groupId, version: stock?.version ?? null }] };
}
declare const checkedStock: unique symbol;
type CheckedStock<T> = T & Readonly<{ [checkedStock]: true }>;
export function checkStock<T extends Context<StockInput>>(value: T) {
  const { input, actor, stock } = value;
  if (actor.role !== 'warehouse' || actor.active !== true || !validId(actor.id) || !validId(actor.groupId)) return fail('Denied');
  if (input.id !== stockId || (stock && (stock.id !== stockId || stock.groupId !== actor.groupId))) return fail('TargetMismatch');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !validId(input.sku) || !validId(input.location) || !Number.isSafeInteger(input.quantity) || input.quantity < 0) return fail('InvalidInput');
  if (input.expectedVersion !== (stock?.version ?? 0)) return fail('Conflict');
  return ok(value as CheckedStock<T>);
}
function operateChecked(value: CheckedStock<Context<StockInput>> & (Readonly<{ mode: 'reserve' }> | Readonly<{ mode: 'release' }> | Readonly<{ mode: 'move'; destination: string }> | Readonly<{ mode: 'adjust'; reason: string }>)) {
  const { input, mode } = value;
  if (mode !== 'adjust' && input.quantity === 0) return fail('InvalidInput');
  if (mode === 'adjust' && (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.trim().length > 1000)) return fail('InvalidInput');
  if (mode === 'move' && (!validId(value.destination) || value.destination === input.location)) return fail('InvalidInput');
  const positions = (value.stock?.positions ?? []).map(row => ({ ...row }));
  let row = positions.find(row => row.sku === input.sku && row.location === input.location);
  if (!row) { row = { sku: input.sku, location: input.location, onHand: 0, reserved: 0 }; positions.push(row); }
  if (mode === 'reserve') {
    if (input.quantity > row.onHand - row.reserved) return fail('InsufficientStock');
    row.reserved += input.quantity;
  } else if (mode === 'release') {
    if (input.quantity > row.reserved) return fail('InsufficientStock');
    row.reserved -= input.quantity;
  } else if (mode === 'adjust') {
    if (input.quantity < row.reserved) return fail('InsufficientStock');
    row.onHand = input.quantity;
  } else {
    if (input.quantity > row.onHand - row.reserved) return fail('InsufficientStock');
    let destination = positions.find(item => item.sku === input.sku && item.location === value.destination);
    if (!destination) { destination = { sku: input.sku, location: value.destination, onHand: 0, reserved: 0 }; positions.push(destination); }
    if (!Number.isSafeInteger(destination.onHand + input.quantity)) return fail('InvalidInput');
    row.onHand -= input.quantity; destination.onHand += input.quantity;
  }
  return ok(stockPlan(value.stock, value.actor, positions, mode === 'adjust' ? { reason: value.reason.trim(), by: value.actor.id } : value.stock?.lastAdjustment ?? null));
}
export const reserveCheckedStock = (value: CheckedStock<Context<StockInput>>) => operateChecked({ ...value, mode: 'reserve' });
export const releaseCheckedStock = (value: CheckedStock<Context<StockInput>>) => operateChecked({ ...value, mode: 'release' });
export const moveCheckedStock = (value: CheckedStock<Context<MoveInput>>) => operateChecked({ ...value, mode: 'move', destination: value.input.destination });
export const adjustCheckedStock = (value: CheckedStock<Context<AdjustInput>>) => operateChecked({ ...value, mode: 'adjust', reason: value.input.reason });
// Compatibility entry points; business declarations connect the checked functions directly.
export function reserveStock(value: Context<StockInput>) { const checked = checkStock(value); return checked.ok ? reserveCheckedStock(checked.value) : checked; }
export function releaseStock(value: Context<StockInput>) { const checked = checkStock(value); return checked.ok ? releaseCheckedStock(checked.value) : checked; }
export function moveStock(value: Context<MoveInput>) { const checked = checkStock(value); return checked.ok ? moveCheckedStock(checked.value) : checked; }
export function adjustStock(value: Context<AdjustInput>) { const checked = checkStock(value); return checked.ok ? adjustCheckedStock(checked.value) : checked; }
function stockChange<T extends Receipt>(change: Change<T>, stock: Stock | null, actor: Actor, before: readonly { sku: string; quantity: number }[], depletion: ReceiptDepletion = 'receiving-only') {
  if (depletion !== 'receiving-only' && depletion !== 'available-locations') return fail('InvalidInput');
  if (stock && (stock.id !== stockId || stock.groupId !== actor.groupId)) return fail('TargetMismatch');
  const positions = (stock?.positions ?? []).map(row => ({ ...row }));
  const after = change.result.state === 'accepted' ? change.result.quantities : [];
  const skus = new Set([...before, ...after].map(row => row.sku));
  for (const sku of skus) {
    const delta = after.filter(row => row.sku === sku).reduce((sum, row) => sum + row.quantity, 0) - before.filter(row => row.sku === sku).reduce((sum, row) => sum + row.quantity, 0);
    if (!Number.isSafeInteger(delta)) return fail('InvalidInput');
    if (delta < 0 && depletion === 'available-locations') {
      // Deterministic business policy: receiving first, then code-unit location order.
      // Stock is fungible per SKU; this does not track receipt lots or serial numbers.
      const eligible = positions.filter(row => row.sku === sku).sort((left, right) =>
        left.location === right.location ? 0 : left.location === 'receiving' ? -1 : right.location === 'receiving' ? 1 : left.location < right.location ? -1 : 1);
      let remaining = -delta;
      for (const row of eligible) {
        if (!Number.isSafeInteger(row.onHand) || !Number.isSafeInteger(row.reserved) || row.reserved < 0 || row.onHand < row.reserved) return fail('InvalidInput');
        const removed = Math.min(remaining, row.onHand - row.reserved);
        row.onHand -= removed; remaining -= removed;
        if (remaining === 0) break;
      }
      if (remaining > 0) return fail('InsufficientStock');
      continue;
    }
    let row = positions.find(row => row.sku === sku && row.location === 'receiving');
    if (!row) { row = { sku, location: 'receiving', onHand: 0, reserved: 0 }; positions.push(row); }
    const next = row.onHand + delta;
    if (!Number.isSafeInteger(next)) return fail('InvalidInput');
    if (next < row.reserved) return fail('InsufficientStock');
    row.onHand = next;
  }
  const inventory = stockPlan(stock, actor, positions);
  return ok<Change<T>>({ result: change.result, checks: [...change.checks, ...inventory.checks], writes: [...change.writes, ...inventory.writes] });
}
type StockFailure = Extract<ReturnType<typeof stockChange>, { ok: false }>['error'];
function withStock<T extends Receipt, E extends RuleError['kind']>(result: Result<Change<T>, Readonly<{ kind: E }>>, stock: Stock | null, actor: Actor, before: readonly { sku: string; quantity: number }[], depletion: ReceiptDepletion = 'receiving-only'): Result<Change<T>, Readonly<{ kind: E }> | StockFailure> {
  if (!result.ok) return result;
  return stockChange(result.value, stock, actor, before, depletion);
}
export type ReceiveStockContext = Loaded<ReceiveInput, Order> & Readonly<{ receipts: readonly Receipt[]; stock: Stock | null }>;
export type ReceiptStockContext<I> = Loaded<I, Receipt> & ReceiptFacts & Readonly<{ stock: Stock | null; receiptDepletion?: ReceiptDepletion }>;
export type ReceiptDecision<C, T extends Receipt = Receipt> = Readonly<{ input: C; value: Change<T> }>;
export const includeReceivedStock = <T extends Receipt>({ input, value }: ReceiptDecision<ReceiveStockContext, T>) => stockChange(value, input.stock, input.actor, []);
export const includeChangedStock = <T extends Receipt>({ input, value }: ReceiptDecision<ReceiptStockContext<VersionInput>, T>) => stockChange(value, input.stock, input.actor, input.current.quantities, input.receiptDepletion);

export const receiveIntoStock = (value: Loaded<ReceiveInput, Order> & Readonly<{ receipts: readonly Receipt[]; stock: Stock | null }>) => withStock(receiveOrder(value), value.stock, value.actor, []);
export const returnFromStock = (value: Loaded<ReasonInput, Receipt> & ReceiptFacts & Readonly<{ stock: Stock | null; receiptDepletion?: ReceiptDepletion }>) => withStock(returnReceipt(value), value.stock, value.actor, value.current.quantities, value.receiptDepletion);
export const correctInStock = (value: Loaded<CorrectInput, Receipt> & ReceiptFacts & Readonly<{ stock: Stock | null; receiptDepletion?: ReceiptDepletion }>) => withStock(correctReceipt(value), value.stock, value.actor, value.current.quantities, value.receiptDepletion);
