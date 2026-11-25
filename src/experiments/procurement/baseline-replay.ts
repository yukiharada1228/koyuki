import type { Result, Execution, Receipt, ReplayReport, ReplayTrace, Trace, ReplayInputError } from '../../framework/index.js';
import { plainProcurement, plainWithCommit } from './plain.js';
import { helperWithCommit } from './helper.js';
import { prepareReplay, type ReplayError, type ReplayRequest } from './replay-identity.js';
import type { ReplayRepository, ReplayCall } from './replay.js';
import type { Committed } from './application.js';
import type { Actor, Policy, Entity, RuleError } from './domain.js';
import type { ProcurementRepository, StorageError } from './repository.js';
type Failure = RuleError | StorageError | ReplayError;
type Input<C> = C extends (input: infer I) => unknown ? I : never;
type Value<C> = C extends (input: never) => Promise<Result<infer O, unknown>> ? O : never;
type Tables = ReturnType<typeof plainProcurement>;
type Replayed<T> = { readonly [G in keyof T]: { readonly [K in keyof T[G]]: {
  readonly run: (call: ReplayCall<Input<T[G][K]>>) => Promise<Result<Execution<Committed<Value<T[G][K]> & Entity>>, Failure | ReplayInputError>>;
  readonly runDetailed: (call: ReplayCall<Input<T[G][K]>>) => Promise<ReplayReport<Committed<Value<T[G][K]> & Entity>, Failure, ReplayError>>;
} } };
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
/** Independent baseline driver. Uses shared identity/storage, never withReplay or business runtime. */
export function baselineReplay(mode: 'plain' | 'helper', repository: ReplayRepository, identity: Actor, configuration: Policy): Replayed<Tables> {
  const actor = Object.freeze({ ...identity }), policy = structuredClone(configuration);
  const factory = mode === 'plain' ? plainWithCommit : helperWithCommit;
  const declared = factory(repository, actor, policy);
  const namespaces = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' } as const;
  const tables: Record<string, Record<string, unknown>> = {};
  for (const group of Object.keys(namespaces) as (keyof Tables)[]) {
    const commands: Record<string, unknown> = {};
    for (const name of Object.keys(declared[group])) {
      const operation = `procurement.${namespaces[group]}.v1.${name}`;
      async function execute(original: ReplayCall<unknown>, detailed: boolean): Promise<ReplayReport<Committed, Failure, ReplayError>> {
        const trace: ReplayTrace[] = [];
        let attempt: ReplayReport<Committed, Failure, ReplayError>['attempt'] = null;
        const report = (result: ReplayReport<Committed, Failure, ReplayError>['result']): ReplayReport<Committed, Failure, ReplayError> => ({ result, trace, attempt });
        let call: ReplayCall<unknown>;
        try { call = structuredClone(original); }
        catch { trace.push({ kind: 'snapshot', status: 'error' }); return report(err({ kind: 'ReplayInputNotCloneable' })); }
        trace.push({ kind: 'snapshot', status: 'ok' });
        const prepared = await prepareReplay(call.requestId, operation, call.input, actor);
        const lookup = (): Result<Receipt<Committed>, ReplayError> | Promise<Result<Receipt<Committed>, ReplayError>> => prepared.ok ? repository.lookupExecution(prepared.value, actor) : prepared;
        const cached = await lookup();
        trace.push({ kind: 'lookup', phase: 'before', status: cached.ok ? cached.value.kind : 'error' });
        if (!cached.ok) return report(cached);
        if (cached.value.kind === 'found') return report(ok({ kind: 'replayed', value: cached.value.value }));
        if (!prepared.ok) throw new Error('MissingPreparedReplayIdentity');
        const request: ReplayRequest = prepared.value;
        const stages: Trace[] = []; let plan: unknown = null, saved: Execution<Committed> | null = null;
        const bound: ProcurementRepository<StorageError | ReplayError> = {
          read: repository.read.bind(repository), related: repository.related.bind(repository),
          commit: async (change, identityActor) => {
            if (detailed) plan = { kind: 'write', operation, input: structuredClone(change) };
            const result = await repository.commitExecution(change, identityActor, request);
            if (!result.ok) return result;
            saved = result.value; return ok(result.value.value.result);
          },
        };
        const declared = factory(bound, actor, policy, detailed ? event => stages.push({
          step: event.stage === 'load' ? `${operation}:load` : event.stage === 'rule' ? 'run:1' : operation, status: event.status,
        }) : undefined);
        const command = (declared[group] as unknown as Record<string, (input: unknown) => Promise<Result<Entity, Failure>>>)[name]!;
        const result = await command(call.input);
        if (result.ok && !saved) throw new Error('MissingProcurementExecution');
        const execution: Result<Execution<Committed>, Failure> = result.ok ? ok(saved!) : result;
        attempt = { result: execution, trace: detailed ? stages : null, plan: detailed ? plan : null };
        trace.push({ kind: 'command', status: execution.ok ? execution.value.kind : 'error' });
        if (execution.ok) return report(execution);
        trace.push({ kind: 'resolution', status: 'lookup' });
        const resolved = await lookup();
        trace.push({ kind: 'lookup', phase: 'after-error', status: resolved.ok ? resolved.value.kind : 'error' });
        if (!resolved.ok) return report(resolved);
        return report(resolved.value.kind === 'found' ? ok({ kind: 'replayed', value: resolved.value.value }) : execution);
      }
      commands[name] = { run: async (call: ReplayCall<unknown>) => (await execute(call, false)).result, runDetailed: (call: ReplayCall<unknown>) => execute(call, true) };
    }
    tables[group] = commands;
  }
  return tables as Replayed<Tables>;
}
