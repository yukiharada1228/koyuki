import { ok, err, type Result } from 'koyuki';
export interface Stock { readonly id: string; readonly units: number; readonly version: number }
export interface Input { readonly requestId: string; readonly source: string; readonly target: string; readonly units: number; readonly sourceVersion: number; readonly targetVersion: number }
export interface Loaded { readonly source: Stock; readonly target: Stock; readonly input: Input }
export type RuleError = { kind: 'InvalidInput' } | { kind: 'InsufficientStock' } | { kind: 'Conflict' } | { kind: 'CorruptStock' };
declare const proof: unique symbol;
type Authorized = Loaded & { readonly [proof]: 'authorized' };
export interface Movement { readonly id: string; readonly source: string; readonly target: string; readonly units: number; readonly sourceVersion: number; readonly targetVersion: number }
export type Change = Readonly<{ before: Loaded; source: Stock; target: Stock; movement: Movement }> & { readonly [proof]: 'change' };
const max = 2_147_483_647;
const positive = (n: number) => Number.isInteger(n) && n > 0 && n <= max;
export const validInput = (input: Input): boolean =>
  [input.requestId, input.source, input.target].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && id.trim() === id) &&
  input.source !== input.target && positive(input.units) && positive(input.sourceVersion) && positive(input.targetVersion);
export function validate(value: Loaded): Result<Authorized, RuleError> {
  if (!validInput(value.input)) return err({ kind: 'InvalidInput' });
  for (const stock of [value.source, value.target]) if (!positive(stock.version) || !Number.isInteger(stock.units) || stock.units < 0 || stock.units > max) return err({ kind: 'CorruptStock' });
  if (value.source.id !== value.input.source || value.target.id !== value.input.target) return err({ kind: 'CorruptStock' });
  if (value.source.version !== value.input.sourceVersion || value.target.version !== value.input.targetVersion) return err({ kind: 'Conflict' });
  if (value.source.units < value.input.units) return err({ kind: 'InsufficientStock' });
  if (value.target.units + value.input.units > max || value.source.version === max || value.target.version === max) return err({ kind: 'InvalidInput' });
  return ok(value as Authorized);
}
export function move(before: Authorized): Result<Change, never> {
  const source = { ...before.source, units: before.source.units - before.input.units, version: before.source.version + 1 };
  const target = { ...before.target, units: before.target.units + before.input.units, version: before.target.version + 1 };
  const change: Omit<Change, typeof proof> = { before, source, target, movement: { id: before.input.requestId, source: source.id, target: target.id, units: before.input.units, sourceVersion: source.version, targetVersion: target.version } };
  return ok(change as Change);
}
