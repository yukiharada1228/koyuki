import type { ActionReport, Result, Trace } from '../../framework/index.js';
import type { StudyCommands } from './comparison-contract.js';
import type { StageSink } from './trace-contract.js';
import type { Actor, Entity, Policy, RuleError } from './domain.js';
import type { ProcurementRepository, StorageError } from './repository.js';
type Factory = (repository: ProcurementRepository, actor: Actor, policy: Policy, observe?: StageSink) => StudyCommands;
type Input<C> = C extends (input: infer I) => unknown ? I : never;
type Success<C> = C extends (input: never) => Promise<Result<infer O, unknown>> ? O : never;
type Failure<C> = C extends (input: never) => Promise<Result<unknown, infer E>> ? E : never;
type Detailed<T> = { readonly [G in keyof T]: { readonly [K in keyof T[G]]: {
  readonly run: T[G][K];
  readonly runDetailed: (input: Input<T[G][K]>) => Promise<ActionReport<Success<T[G][K]>, Failure<T[G][K]>>>;
} } };
/** Baseline-owned diagnostics: no Koyuki action/Workflow/runtime execution. */
export function baselineDetail<const F extends Factory>(factory: F, repository: ProcurementRepository, identity: Actor, configuration: Policy): Detailed<ReturnType<F>> {
  const actor = Object.freeze({ ...identity }), policy = structuredClone(configuration);
  const declared = factory(repository, actor, policy);
  const namespaces = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' } as const;
  const tables: Record<string, Record<string, unknown>> = {};
  for (const group of Object.keys(namespaces) as (keyof StudyCommands)[]) {
    const entries: Record<string, unknown> = {};
    for (const name of Object.keys(declared[group])) {
      const operation = `procurement.${namespaces[group]}.v1.${name}`;
      const runDetailed = async (input: unknown): Promise<ActionReport<Entity, RuleError | StorageError>> => {
        const trace: Trace[] = [];
        let plan: unknown = null;
        const bound: ProcurementRepository = {
          read: repository.read.bind(repository), related: repository.related.bind(repository),
          commit: (change, identityActor) => {
            plan = { kind: 'write', operation, input: structuredClone(change) };
            return repository.commit(change, identityActor);
          },
        };
        const commands = factory(bound, actor, policy, event => trace.push({
          step: event.stage === 'load' ? `${operation}:load` : event.stage === 'rule' ? 'run:1' : operation,
          status: event.status,
        }));
        // Each public table retains its own signature; only runtime key dispatch is erased.
        const command = (commands[group] as unknown as Record<string, (input: unknown) => Promise<Result<Entity, RuleError | StorageError>>>)[name]!;
        const result = await command(input);
        return { result, trace, plan };
      };
      entries[name] = { run: async (input: unknown) => (await runDetailed(input)).result, runDetailed };
    }
    tables[group] = entries;
  }
  return tables as Detailed<ReturnType<F>>;
}
