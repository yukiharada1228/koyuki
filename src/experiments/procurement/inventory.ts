import { ok, err, type Result } from '../../framework/index.js';
import { receiveOrder, returnReceipt, correctReceipt, type Actor, type Stock, type Position, type Change, type Receipt,
  type Loaded, type ReceiveInput, type ReasonInput, type CorrectInput, type Order, type ReceiptFacts, type RuleError } from './domain.js';
export const stockId = 'warehouse';
export type StockInput = Readonly<{ id: string; expectedVersion: number; sku: string; location: string; quantity: number }>;
export type MoveInput = StockInput & Readonly<{ destination: string }>;
export type AdjustInput = StockInput & Readonly<{ reason: string }>;
type Context<I> = Readonly<{ input: I; actor: Actor; stock: Stock | null }>;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const fail = (kind: RuleError['kind']): Result<never, RuleError> => err({ kind });
function stockPlan(stock: Stock | null, actor: Actor, positions: readonly Position[], lastAdjustment = stock?.lastAdjustment ?? null): Change<Stock> {
  const result: Stock = { kind: 'stock', id: stockId, groupId: actor.groupId, version: (stock?.version ?? 0) + 1, positions, lastAdjustment };
  return { result, writes: [result], checks: [{ kind: 'stock', id: stockId, groupId: actor.groupId, version: stock?.version ?? null }] };
}
function guard(value: Context<StockInput>): Result<readonly Position[], RuleError> {
  const { input, actor, stock } = value;
  if (actor.role !== 'warehouse' || actor.active !== true || !validId(actor.id) || !validId(actor.groupId)) return fail('Denied');
  if (input.id !== stockId || (stock && (stock.id !== stockId || stock.groupId !== actor.groupId))) return fail('TargetMismatch');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !validId(input.sku) || !validId(input.location) || !Number.isSafeInteger(input.quantity) || input.quantity < 0) return fail('InvalidInput');
  if (input.expectedVersion !== (stock?.version ?? 0)) return fail('Conflict');
  return ok(stock?.positions ?? []);
}
function operate(value: Context<StockInput> & (Readonly<{ mode: 'reserve' }> | Readonly<{ mode: 'release' }> | Readonly<{ mode: 'move'; destination: string }> | Readonly<{ mode: 'adjust'; reason: string }>)): Result<Change<Stock>, RuleError> {
  const checked = guard(value); if (!checked.ok) return checked;
  const { input, mode } = value;
  if (mode !== 'adjust' && input.quantity === 0) return fail('InvalidInput');
  if (mode === 'adjust' && (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.trim().length > 1000)) return fail('InvalidInput');
  if (mode === 'move' && (!validId(value.destination) || value.destination === input.location)) return fail('InvalidInput');
  const positions = checked.value.map(row => ({ ...row }));
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
export const reserveStock = (value: Context<StockInput>) => operate({ ...value, mode: 'reserve' });
export const releaseStock = (value: Context<StockInput>) => operate({ ...value, mode: 'release' });
export const moveStock = (value: Context<MoveInput>) => operate({ ...value, mode: 'move', destination: value.input.destination });
export const adjustStock = (value: Context<AdjustInput>) => operate({ ...value, mode: 'adjust', reason: value.input.reason });
function withStock(result: Result<Change<Receipt>, RuleError>, stock: Stock | null, actor: Actor, before: readonly { sku: string; quantity: number }[]): Result<Change<Receipt>, RuleError> {
  if (!result.ok) return result;
  if (stock && (stock.id !== stockId || stock.groupId !== actor.groupId)) return fail('TargetMismatch');
  const positions = (stock?.positions ?? []).map(row => ({ ...row }));
  const after = result.value.result.state === 'accepted' ? result.value.result.quantities : [];
  const skus = new Set([...before, ...after].map(row => row.sku));
  for (const sku of skus) {
    const delta = after.filter(row => row.sku === sku).reduce((sum, row) => sum + row.quantity, 0) - before.filter(row => row.sku === sku).reduce((sum, row) => sum + row.quantity, 0);
    let row = positions.find(row => row.sku === sku && row.location === 'receiving');
    if (!row) { row = { sku, location: 'receiving', onHand: 0, reserved: 0 }; positions.push(row); }
    const next = row.onHand + delta;
    if (!Number.isSafeInteger(next)) return fail('InvalidInput');
    if (next < row.reserved) return fail('InsufficientStock');
    row.onHand = next;
  }
  const inventory = stockPlan(stock, actor, positions);
  return ok({ result: result.value.result, checks: [...result.value.checks, ...inventory.checks], writes: [...result.value.writes, ...inventory.writes] });
}
export const receiveIntoStock = (value: Loaded<ReceiveInput, Order> & Readonly<{ receipts: readonly Receipt[]; stock: Stock | null }>) => withStock(receiveOrder(value), value.stock, value.actor, []);
export const returnFromStock = (value: Loaded<ReasonInput, Receipt> & ReceiptFacts & Readonly<{ stock: Stock | null }>) => withStock(returnReceipt(value), value.stock, value.actor, value.current.quantities);
export const correctInStock = (value: Loaded<CorrectInput, Receipt> & ReceiptFacts & Readonly<{ stock: Stock | null }>) => withStock(correctReceipt(value), value.stock, value.actor, value.current.quantities);
