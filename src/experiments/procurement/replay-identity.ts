import { ok, err, type Result } from '../../framework/index.js';
import type { Actor, Entity } from './domain.js';
import type { Committed } from './application.js';
/** A request ID names history; the operation boundary must still validate its model. */
export function requireExecutionKind(value: Committed, kind: Entity['kind']): void {
  if (value.result.kind !== kind) throw new Error('UnexpectedProcurementExecutionKind');
}
export type ReplayRequest = Readonly<{ requestId: string; operation: string; fingerprint: string }>;
export type ReplayError = Readonly<{ kind: 'InvalidReplayRequest' | 'ReplayMismatch' | 'Denied' | 'CommitUnknown' }>;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim();
export function replayAccess(request: ReplayRequest, actor: Actor): ReplayError | null {
  if (actor.active !== true || !identifier(actor.id) || !identifier(actor.groupId) || !['buyer', 'approver', 'warehouse', 'finance'].includes(actor.role)) return { kind: 'Denied' };
  if (!identifier(request.requestId) || !identifier(request.operation) || typeof request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.fingerprint)) return { kind: 'InvalidReplayRequest' };
  return null;
}
function canonical(value: unknown, seen: Set<object>, depth = 0): string {
  if (depth > 50) throw new Error('InvalidReplayValue');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('InvalidReplayValue');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) throw new Error('InvalidReplayValue');
      return '[' + Array.from(value, item => canonical(item, seen, depth + 1)).join(',') + ']';
    }
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length) throw new Error('InvalidReplayValue');
    const row = value as Record<string, unknown>;
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key], seen, depth + 1)).join(',') + '}';
  } finally { seen.delete(value); }
}
/** Snapshot and identity belong to the host boundary; hashing uses only Web Crypto. */
export async function prepareReplay(requestId: string, operation: string, input: unknown, actor: Actor): Promise<Result<ReplayRequest, ReplayError>> {
  const provisional = { requestId, operation, fingerprint: '0'.repeat(64) };
  const denied = replayAccess(provisional, actor); if (denied) return err(denied);
  let serialized: string;
  try { serialized = canonical({ operation, actor: { id: actor.id, role: actor.role, groupId: actor.groupId }, input }, new Set()); }
  catch { return err({ kind: 'InvalidReplayRequest' }); }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return ok({ requestId, operation, fingerprint: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('') });
}
