import { defineApplication, operations, ok, err, type Result, type Execution, type ReplayInputError } from '../../framework/index.js';
import { procurementReplay, type ReplayRepository } from './replay.js';
import { applyCommitted, type Projection } from './projection.js';
import type { Committed } from './application.js';
import type { Actor, Entity, Policy, RuleError } from './domain.js';
import type { StorageError } from './repository.js';
import type { ReplayError } from './replay-identity.js';
export type EntityKey = Readonly<{ kind: Entity['kind']; id: string }>;
export type ProjectionError = Readonly<{ kind: 'ProjectionUnavailable' }>;
export interface CurrentRepository extends ReplayRepository {
  /** One consistent current read; never return a partial patch on failure. */
  readonly current: (keys: readonly EntityKey[], actor: Actor) => Result<readonly Entity[], ProjectionError> | Promise<Result<readonly Entity[], ProjectionError>>;
}
type Failure = RuleError | StorageError | ReplayError | ReplayInputError;
type Command = { readonly run: (input: never) => Promise<Result<Execution<Committed>, Failure>> };
type Input<C> = C extends { run(input: infer I): unknown } ? I : never;
type Completion =
  | Readonly<{ kind: 'committed'; execution: Extract<Execution<Committed>, { kind: 'committed' }> }>
  | Readonly<{ kind: 'refreshed'; execution: Extract<Execution<Committed>, { kind: 'replayed' }>; current: readonly Entity[] }>;
function refreshed<const P extends string, const T extends Record<string, Command>>(prefix: P, commands: T, repository: CurrentRepository, actor: Actor) {
  const entries = Object.entries(commands).map(([key, command]) => [key, {
    run: async (input: never): Promise<Result<Completion, Failure | ProjectionError>> => {
      const result = await command.run(input); if (!result.ok) return result;
      if (result.value.kind === 'committed') return ok({ kind: 'committed', execution: result.value });
      const current = await repository.current(result.value.value.writes.map(entity => ({ kind: entity.kind, id: entity.id })), actor);
      if (!current.ok) return current;
      const expected = new Map(result.value.value.writes.map(entity => [JSON.stringify([entity.kind, entity.id]), entity.version]));
      const seen = new Set<string>();
      for (const entity of current.value) {
        const key = JSON.stringify([entity.kind, entity.id]), version = expected.get(key);
        if (entity.groupId !== actor.groupId || seen.has(key) || version === undefined || !Number.isSafeInteger(entity.version) || entity.version < version) return err({ kind: 'ProjectionUnavailable' });
        seen.add(key);
      }
      if (seen.size !== expected.size) return err({ kind: 'ProjectionUnavailable' });
      return ok({ kind: 'refreshed', execution: result.value, current: current.value });
    },
  }]);
  // Runtime key mapping preserves the existing operation-specific input contract.
  const bound = Object.fromEntries(entries) as { [K in keyof T]: { run(input: Input<T[K]>): Promise<Result<Completion, Failure | ProjectionError>> } };
  const projected = operations(bound, (state: Projection, output: Completion) => applyCommitted(state, {
    result: output.execution.value.result,
    writes: output.kind === 'committed' ? output.execution.value.writes : output.current,
  }));
  return Object.fromEntries(Object.entries(projected).map(([key, value]) => [`${prefix}.${key}`, value])) as {
    [K in keyof typeof projected as `${P}.${Extract<K, string>}`]: typeof projected[K]
  };
}
/** Replay output stays historical; this optional host application reads current values for its View. */
export function procurementCurrentApplication(repository: CurrentRepository, identity: Actor, policy: Policy, initial: readonly Entity[] = []) {
  const actor = Object.freeze({ ...identity });
  if (initial.some(entity => entity.groupId !== actor.groupId)) throw new Error('ProjectionScopeMismatch');
  const seed = structuredClone(initial), commands = procurementReplay(repository, actor, policy);
  return defineApplication({
    initial: (): Projection => ({ groupId: actor.groupId, entities: structuredClone(seed) }),
    operations: {
      ...refreshed('request', commands.requests, repository, actor), ...refreshed('order', commands.orders, repository, actor),
      ...refreshed('receipt', commands.receipts, repository, actor), ...refreshed('invoice', commands.invoices, repository, actor),
      ...refreshed('payment', commands.payments, repository, actor), ...refreshed('inventory', commands.inventory, repository, actor),
    },
    view: state => ({ entities: state.data.entities, busy: state.kind === 'running',
      error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}
