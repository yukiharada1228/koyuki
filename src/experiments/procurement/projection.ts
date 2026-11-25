import { procurementReplay, type ReplayRepository } from './replay.js';
import type { ReplayError } from './replay-identity.js';
import { defineApplication, operations, replayOperations, type OperationCommands, type Execution, type ReplayInputError, type Result } from '../../framework/index.js';
import { procurementChanges, type Committed } from './application.js';
import type { Entity, Actor, Policy, RuleError } from './domain.js';
import type { ProcurementRepository, StorageError } from './repository.js';
export type Projection = Readonly<{ groupId: string; entities: readonly Entity[] }>;
/** Pure projection of all writes. Versions prevent stale output from rewinding known entities. */
export function applyCommitted(before: Projection, output: Committed): Projection {
  const entities = new Map(before.entities.map(entity => [JSON.stringify([entity.kind, entity.id]), entity]));
  for (const entity of output.writes) {
    if (entity.groupId !== before.groupId) throw new Error('ProjectionScopeMismatch');
    const key = JSON.stringify([entity.kind, entity.id]), current = entities.get(key);
    if (!current || current.version < entity.version) entities.set(key, structuredClone(entity));
  }
  return { groupId: before.groupId, entities: [...entities.values()] };
}
type Command = { readonly run: (input: never) => Promise<Result<Committed, RuleError | StorageError>> };
/** Example-local namespacing avoids collisions between request and invoice approval. */
function namespaced<const P extends string, const T extends Record<string, Command>>(prefix: P, commands: OperationCommands<T>) {
  const projected = operations(commands, applyCommitted);
  return Object.fromEntries(Object.entries(projected).map(([key, value]) => [`${prefix}.${key}`, value])) as {
    [K in keyof typeof projected as `${P}.${Extract<K, string>}`]: typeof projected[K]
  };
}
export function procurementApplication(repository: ProcurementRepository, actor: Actor, policy: Policy, initial: readonly Entity[] = []) {
  if (initial.some(entity => entity.groupId !== actor.groupId)) throw new Error('ProjectionScopeMismatch');
  const seed = structuredClone(initial), groupId = actor.groupId;
  const commands = procurementChanges(repository, actor, policy);
  return defineApplication({
    initial: (): Projection => ({ groupId, entities: structuredClone(seed) }),
    operations: {
      ...namespaced('request', commands.requests), ...namespaced('order', commands.orders),
      ...namespaced('receipt', commands.receipts), ...namespaced('invoice', commands.invoices),
      ...namespaced('payment', commands.payments), ...namespaced('inventory', commands.inventory),
    },
    view: state => ({ entities: state.data.entities, busy: state.kind === 'running',
      error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}

type ReplayCommand = { readonly run: (input: never) => Promise<Result<Execution<Committed>, RuleError | StorageError | ReplayError | ReplayInputError>> };
function replayNamespaced<const P extends string, const T extends Record<string, ReplayCommand>>(prefix: P, commands: OperationCommands<T>) {
  const projected = replayOperations(commands, applyCommitted);
  return Object.fromEntries(Object.entries(projected).map(([key, value]) => [`${prefix}.${key}`, value])) as {
    [K in keyof typeof projected as `${P}.${Extract<K, string>}`]: typeof projected[K]
  };
}
export function procurementReplayApplication(repository: ReplayRepository, actor: Actor, policy: Policy, initial: readonly Entity[] = []) {
  if (initial.some(entity => entity.groupId !== actor.groupId)) throw new Error('ProjectionScopeMismatch');
  const seed = structuredClone(initial), groupId = actor.groupId;
  const commands = procurementReplay(repository, actor, policy);
  return defineApplication({
    initial: (): Projection => ({ groupId, entities: structuredClone(seed) }),
    operations: {
      ...replayNamespaced('request', commands.requests), ...replayNamespaced('order', commands.orders),
      ...replayNamespaced('receipt', commands.receipts), ...replayNamespaced('invoice', commands.invoices),
      ...replayNamespaced('payment', commands.payments), ...replayNamespaced('inventory', commands.inventory),
    },
    view: state => ({ entities: state.data.entities, busy: state.kind === 'running',
      error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}
