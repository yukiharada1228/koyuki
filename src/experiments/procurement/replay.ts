import { withReplay, ok, type Result, type Receipt, type Execution, type ActionReport } from '../../framework/index.js';
import { procurementChanges, type Committed } from './application.js';
import { prepareReplay, type ReplayRequest, type ReplayError } from './replay-identity.js';
import type { Actor, Policy, Entity, Change, RuleError } from './domain.js';
import type { ProcurementRepository, StorageError } from './repository.js';
export interface ReplayRepository extends ProcurementRepository {
  readonly lookupExecution: (request: ReplayRequest, actor: Actor) => Result<Receipt<Committed>, ReplayError> | Promise<Result<Receipt<Committed>, ReplayError>>;
  readonly commitExecution: <T extends Entity>(change: Change<T>, actor: Actor, request: ReplayRequest) => Promise<Result<Execution<Committed<T>>, StorageError | ReplayError>>;
}
export type ReplayCall<I> = Readonly<{ requestId: string; input: I }>;
type Failure = RuleError | StorageError | ReplayError;
type Input<C> = C extends { run(input: infer I): unknown } ? I : never;
// Historical results are not proved by the current decision's narrower success type.
// Keep the model-wide receipt contract until lookup validates per-operation outcomes.
type Output<C> = C extends { run(input: never): Promise<Result<infer O, unknown>> }
  ? O extends Committed<infer T extends Entity> ? Committed<Extract<Entity, { kind: T['kind'] }>> : O : never;
type Tables = ReturnType<typeof procurementChanges<StorageError>>;
type Replayed<T> = { readonly [K in keyof T]: ReturnType<typeof withReplay<ReplayCall<Input<T[K]>>, Output<T[K]>, Failure, ReplayError>> };
type RuntimeCommand = { run(input: unknown): Promise<Result<Committed, Failure>>; runDetailed(input: unknown): Promise<ActionReport<Committed, Failure>> };
/** Reuse all business declarations; every invocation owns its bound commit context. */
export function procurementReplay(repository: ReplayRepository, trustedActor: Actor, configuration: Policy): { readonly [G in keyof Tables]: Replayed<Tables[G]> } {
  const actor = Object.freeze({ ...trustedActor }), policy = structuredClone(configuration);
  const declared = procurementChanges(repository, actor, policy);
  const namespaces = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' } as const;
  const tables: Record<string, Record<string, unknown>> = {};
  for (const group of Object.keys(namespaces) as (keyof Tables)[]) {
    const commands: Record<string, unknown> = {};
    for (const name of Object.keys(declared[group])) {
      const operation = `procurement.${namespaces[group]}.v1.${name}`;
      const execute = async (call: ReplayCall<unknown>, detailed: boolean): Promise<ActionReport<Execution<Committed>, Failure>> => {
        const identity = await prepareReplay(call.requestId, operation, call.input, actor);
        if (!identity.ok) return { result: identity, trace: [], plan: null };
        let saved: Execution<Committed> | null = null;
        const bound: ProcurementRepository<StorageError | ReplayError> = {
          read: repository.read.bind(repository), related: repository.related.bind(repository),
          commit: async (change, identityActor) => {
            const result = await repository.commitExecution(change, identityActor, identity.value);
            if (!result.ok) return result;
            saved = result.value;
            return ok(result.value.value.result);
          },
        };
        // The public mapped table preserves each key's input/output; erase only runtime dispatch.
        const table = procurementChanges(bound, actor, policy)[group] as unknown as Record<string, RuntimeCommand>;
        const command = table[name]!;
        const report = detailed ? await command.runDetailed(call.input) : { result: await command.run(call.input), trace: [], plan: null };
        if (!report.result.ok) return { ...report, result: report.result };
        if (!saved) throw new Error('MissingProcurementExecution');
        // Use the adapter's historical output for a concurrent replay, never the losing plan's writes.
        return { ...report, result: ok(saved) };
      };
      commands[name] = withReplay({ run: async (call: ReplayCall<unknown>) => (await execute(call, false)).result,
        runDetailed: (call: ReplayCall<unknown>) => execute(call, true) }, {
        lookup: async (call: ReplayCall<unknown>) => {
          const identity = await prepareReplay(call.requestId, operation, call.input, actor);
          return identity.ok ? repository.lookupExecution(identity.value, actor) : identity;
        }, resolveAfter: () => true,
      });
    }
    tables[group] = commands;
  }
  return tables as { readonly [G in keyof Tables]: Replayed<Tables[G]> };
}
