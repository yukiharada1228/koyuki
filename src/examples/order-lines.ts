// A pure line-item example, not a complete purchasing application.
import { collectEach, defineTransition, defineUseCase, ok, err, type Result } from '../framework/index.js';
export interface Line { readonly sku: string; readonly quantity: number; readonly unitPriceYen: number }
export type LineError = { kind: 'InvalidSku' } | { kind: 'InvalidQuantity' } | { kind: 'InvalidUnitPrice' } | { kind: 'LineTotalOverflow' };
declare const proof: unique symbol;
export type ValidatedLine = Readonly<Line & { subtotalYen: number }> & { readonly [proof]: 'validated-line' };
export interface Quote { readonly lines: readonly ValidatedLine[]; readonly totalYen: number }
export function validateLine(line: Line): Result<ValidatedLine, LineError> {
  if (!line.sku.trim()) return err({ kind: 'InvalidSku' });
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) return err({ kind: 'InvalidQuantity' });
  if (!Number.isSafeInteger(line.unitPriceYen) || line.unitPriceYen < 0) return err({ kind: 'InvalidUnitPrice' });
  const subtotalYen = line.quantity * line.unitPriceYen;
  if (!Number.isSafeInteger(subtotalYen)) return err({ kind: 'LineTotalOverflow' });
  return ok(Object.freeze({ ...line, sku: line.sku.trim(), subtotalYen }) as ValidatedLine);
}
export function priceLines(lines: readonly ValidatedLine[]): Result<Quote, { kind: 'EmptyOrder' } | { kind: 'OrderTotalOverflow' }> {
  if (!lines.length) return err({ kind: 'EmptyOrder' });
  let totalYen = 0;
  for (const line of lines) {
    totalYen += line.subtotalYen;
    if (!Number.isSafeInteger(totalYen)) return err({ kind: 'OrderTotalOverflow' });
  }
  return ok(Object.freeze({ lines, totalYen }));
}
export const validateLines = collectEach(validateLine);
export function orderLinesOperation<S, E>(save: (quote: Quote) => Promise<Result<S, E>>) {
  return defineUseCase({ operation: 'order-lines.quote.v1', load: async (input: readonly Line[]) => ok(input),
    transition: defineTransition({ validate: collectEach(validateLine), evolve: priceLines }), save,
  });
}
