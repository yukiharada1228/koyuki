import { ok, err, type Result } from '../../framework/index.js';
import { type Actor, type Entity, type Change } from './domain.js';
export type StorageError = Readonly<{ kind: 'NotFound' | 'Conflict' }>;
export interface ProcurementRepository {
  readonly read: <K extends Entity['kind']>(kind: K, id: string, actor: Actor) => Result<Extract<Entity, { kind: K }>, StorageError> | Promise<Result<Extract<Entity, { kind: K }>, StorageError>>;
  readonly list: <K extends Entity['kind']>(kind: K, actor: Actor) => readonly Extract<Entity, { kind: K }>[] | Promise<readonly Extract<Entity, { kind: K }>[]>;
  readonly commit: <T extends Entity>(change: Change<T>, actor: Actor) => Promise<Result<T, StorageError>>;
}
const key = (kind: Entity['kind'], group: string, id: string) => JSON.stringify([kind, group, id]);
/** Deterministic evaluation adapter. Atomicity here is one synchronous JS commit, not a DB guarantee. */
export class MemoryProcurement implements ProcurementRepository {
  private readonly records = new Map<string, Entity>();
  commits = 0;
  read<K extends Entity['kind']>(kind: K, id: string, actor: Actor): Result<Extract<Entity, { kind: K }>, StorageError> {
    const entity = this.records.get(key(kind, actor.groupId, id));
    return entity?.kind === kind ? ok(structuredClone(entity) as Extract<Entity, { kind: K }>) : err({ kind: 'NotFound' });
  }
  list<K extends Entity['kind']>(kind: K, actor: Actor): readonly Extract<Entity, { kind: K }>[] {
    return [...this.records.values()].filter(entity => entity.kind === kind && entity.groupId === actor.groupId).map(entity => structuredClone(entity) as Extract<Entity, { kind: K }>);
  }
  async commit<T extends Entity>(change: Change<T>, actor: Actor): Promise<Result<T, StorageError>> {
    for (const condition of change.checks) {
      if (condition.groupId !== actor.groupId || (this.records.get(key(condition.kind, condition.groupId, condition.id))?.version ?? null) !== condition.version) return err({ kind: 'Conflict' });
    }
    const written = new Set<string>();
    for (const entity of change.writes) {
      const id = key(entity.kind, entity.groupId, entity.id), before = change.checks.find(condition => key(condition.kind, condition.groupId, condition.id) === id);
      if (entity.groupId !== actor.groupId || written.has(id) || !before || !Number.isSafeInteger(entity.version) || entity.version !== (before.version ?? 0) + 1) return err({ kind: 'Conflict' });
      if (entity.kind === 'order' && entity.state !== 'cancelled' && this.list('order', actor).some(other => other.state !== 'cancelled' && other.requestId === entity.requestId && other.id !== entity.id)) return err({ kind: 'Conflict' });
      if (entity.kind === 'invoice' && entity.state !== 'voided' && this.list('invoice', actor).some(other => other.state !== 'voided' && other.orderId === entity.orderId && other.id !== entity.id)) return err({ kind: 'Conflict' });
      if (entity.kind === 'payment' && this.list('payment', actor).some(other => other.id !== entity.id && (other.reference === entity.reference || (entity.state === 'recorded' && other.state === 'recorded' && other.invoiceId === entity.invoiceId)))) return err({ kind: 'Conflict' });
      written.add(id);
    }
    // Prepare every clone before mutating any aggregate, including the returned value.
    const staged = change.writes.map(entity => [key(entity.kind, entity.groupId, entity.id), structuredClone(entity)] as const);
    const result = structuredClone(change.result);
    for (const [id, entity] of staged) this.records.set(id, entity);
    this.commits++; return ok(result);
  }
}
