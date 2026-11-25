import { inheritDetailed, invokeDetailed, registerDetailed } from './instrumentation.js';
import { observeEffect } from './observation.js';
import type { StageObserver } from './workflow.js';
import { registerStructure, structureOf, structureSequence, structureStep, structureBranch, emptyStructure } from './structure.js';
import type { OperationReport, CheckedDetails } from './execution.js';
import { snapshotData } from './snapshot.js';
import { err, ok, type Result } from './result.js';
import type { ActionReport } from './action.js';
import type { Trace } from './workflow.js';
import { operation, type Operation } from './application.js';
import { operationEntries } from './operation-table.js';

/** The adapter must distinguish a new atomic commit from a concurrent winner's receipt. */
export type Execution<O> =
  | { readonly kind: 'committed'; readonly value: O }
  | { readonly kind: 'replayed'; readonly value: O };
export type Receipt<O> = { readonly kind: 'missing' } | { readonly kind: 'found'; readonly value: O };
export interface ReplayBoundary<I, O, E, RE> {
  readonly lookup: (input: I) => Result<Receipt<O>, RE> | Promise<Result<Receipt<O>, RE>>;
  /** Explicitly classify conflict or unknown-commit failures eligible for receipt resolution. */
  readonly resolveAfter: (error: E) => boolean;
}
export type ReplayInputError = { readonly kind: 'ReplayInputNotCloneable' };

export type ReplayTrace =
  | { readonly kind: 'snapshot'; readonly status: 'ok' | 'error' }
  | { readonly kind: 'lookup'; readonly phase: 'before' | 'after-error'; readonly status: 'found' | 'missing' | 'error' }
  | { readonly kind: 'command'; readonly status: 'committed' | 'replayed' | 'error' }
  | { readonly kind: 'resolution'; readonly status: 'lookup' | 'skip' };
export interface ReplayReport<O, E, RE> {
  readonly result: Result<Execution<O>, E | RE | ReplayInputError>;
  readonly trace: readonly ReplayTrace[];
  /** null means not executed; trace:null means executed without command-level instrumentation. */
  readonly attempt: {
    readonly result: Result<Execution<O>, E>;
    readonly trace: readonly Trace[] | null;
    readonly plan: unknown;
  } | null;
}

/** Optional receipt boundary; never retries a command. Unexpected exceptions still reject.
 * run preserves the original run path. runDetailed uses command detail when supplied.
 */
export function withReplay<I, O, E, RE>(command: {
  readonly run: (input: I) => Promise<Result<Execution<O>, E>>;
  readonly runDetailed?: (input: NoInfer<I>) => Promise<ActionReport<Execution<NoInfer<O>>, NoInfer<E>>>;
}, boundary: ReplayBoundary<NoInfer<I>, NoInfer<O>, NoInfer<E>, RE>) {
  const runCommand = command.run.bind(command);
  const detail = command.runDetailed;
  const detailedCommand = detail ? inheritDetailed(detail.bind(command), detail) : undefined;
  const lookup = boundary.lookup.bind(boundary), resolveAfter = boundary.resolveAfter.bind(boundary);
  async function execute(input: I, detailed: boolean, observe?: StageObserver): Promise<ReplayReport<O, E, RE>> {
    const trace: ReplayTrace[] = [];
    let attempt: ReplayReport<O, E, RE>['attempt'] = null;
    const report = (result: ReplayReport<O, E, RE>['result']): ReplayReport<O, E, RE> => ({ result, trace, attempt });
    let request: I;
    const snapshot = observe?.('replay.snapshot', input);
    try { request = snapshotData(input); }
    catch { const failure = err({ kind: 'ReplayInputNotCloneable' as const }); snapshot?.(failure); trace.push({ kind: 'snapshot', status: 'error' }); return report(failure); }
    snapshot?.(ok(request));
    trace.push({ kind: 'snapshot', status: 'ok' });
    const cached = observe ? await observeEffect('replay.lookup:before', request, () => lookup(request), observe) : await lookup(request);
    trace.push({ kind: 'lookup', phase: 'before', status: cached.ok ? cached.value.kind : 'error' });
    if (!cached.ok) return report(cached);
    if (cached.value.kind === 'found') return report(ok({ kind: 'replayed', value: cached.value.value }));
    const performCommand = async () => {
      if (detailed && detailedCommand) attempt = await invokeDetailed(detailedCommand, request, observe);
      else attempt = { result: await runCommand(request), trace: null, plan: null };
      return attempt.result;
    };
    if (observe) await observeEffect('replay.command', request, performCommand, observe); else await performCommand();
    if (!attempt) throw new Error('ReplayAttemptMissing');
    const result = (attempt as NonNullable<ReplayReport<O, E, RE>['attempt']>).result;
    trace.push({ kind: 'command', status: result.ok ? result.value.kind : 'error' });
    if (result.ok) return report(result);
    const finishResolution = observe?.scope?.('replay.resolve-after');
    let resolve: boolean;
    try { resolve = resolveAfter(result.error); finishResolution?.('ok'); }
    catch (cause) { finishResolution?.('defect'); throw cause; }
    trace.push({ kind: 'resolution', status: resolve ? 'lookup' : 'skip' });
    if (!resolve) return report(result);
    const raced = observe ? await observeEffect('replay.lookup:after-error', request, () => lookup(request), observe) : await lookup(request);
    trace.push({ kind: 'lookup', phase: 'after-error', status: raced.ok ? raced.value.kind : 'error' });
    if (!raced.ok) return report(raced);
    return report(raced.value.kind === 'found' ? ok({ kind: 'replayed', value: raced.value.value }) : result);
  }
  return registerStructure({
    run: async (input: I): Promise<Result<Execution<O>, E | RE | ReplayInputError>> => (await execute(input, false)).result,
    runDetailed: registerDetailed((input: I): Promise<ReplayReport<O, E, RE>> => execute(input, true), (input: I, observe) => execute(input, true, observe)),
  }, structureSequence(structureStep('replay.snapshot'), structureStep('replay.lookup:before', 'effect'),
    structureBranch('replay.cached', emptyStructure, structureSequence(structureOf(command),
      structureBranch('replay.command-failed', structureBranch('replay.resolve-after', structureStep('replay.lookup:after-error', 'effect'), emptyStructure), emptyStructure)))));
}

/** Preserve the current projection on replay. Refreshing stale projections is host-owned. */
export function replayOperation<S, I, O, E>(command: {
  readonly run: (input: I) => Promise<Result<Execution<O>, E>>;
  readonly runDetailed?: (input: NoInfer<I>) => Promise<OperationReport<Execution<NoInfer<O>>, NoInfer<E>>>;
}, reduce: (state: S, output: NoInfer<O>) => S): Operation<S, I, Execution<O>, E> {
  return operation(command, (state, execution) => execution.kind === 'replayed' ? state : reduce(state, execution.value));
}

/** Register commands sharing one projection rule, preserving each input/error pair. */
export function replayOperations<S, const T extends Record<string, {
  run(input: never): Promise<Result<Execution<unknown>, unknown>>;
}>>(commands: T & NoInfer<CheckedDetails<T>>, reduce: (state: S, output: ReplayOutput<T[keyof T]>) => S): {
  [K in keyof T]: Operation<S, ReplayInput<T[K]>, Execution<ReplayOutput<T[K]>>, ReplayError<T[K]>>
} {
  // Each key retains its own command. Only the shared projection rule is widened here.
  const entries = operationEntries(commands).map(([key, command]) => [key,
    replayOperation(command, reduce as (state: S, output: unknown) => S),
  ]);
  return Object.fromEntries(entries) as {
    [K in keyof T]: Operation<S, ReplayInput<T[K]>, Execution<ReplayOutput<T[K]>>, ReplayError<T[K]>>
  };
}
type ReplayCall<T> = T extends { run: infer F } ? F : never;
type ReplayInput<T> = [ReplayCall<T>] extends [(input: infer I) => unknown] ? I : never;
type ReplayOutput<T> = T extends { run(input: never): Promise<Result<Execution<infer O>, unknown>> } ? O : never;
type ReplayError<T> = T extends { run(input: never): Promise<Result<unknown, infer E>> } ? E : never;
