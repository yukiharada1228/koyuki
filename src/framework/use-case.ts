import type { Result } from './result.js';
import type { ActionReport } from './action.js';
import { defineRequestTarget, type RequestExecution, type Step, type TransitionDefinition } from './model.js';
import { withReplay, type Execution, type ReplayBoundary, type ReplayInputError, type ReplayReport } from './replay.js';
type AnyStep = Step<never, unknown, unknown>;
type Failure<T> = T extends Step<never, unknown, infer E> ? E : never;
export type Errors<LE, VE, T extends readonly AnyStep[], E, SE> = LE | VE | Failure<T[number]> | E | SE;
type Definition<I, C, LE, V, VE, T extends readonly AnyStep[], O, E, S, SE> = {
  operation: string;
  loadName?: string;
  load: (input: I) => Promise<Result<C, LE>>;
  transition: TransitionDefinition<NoInfer<C>, V, VE, T, O, E>;
  save: (change: NoInfer<O>, execution: RequestExecution<NoInfer<I>>) => Promise<Result<S, SE>>;
};
type ReplayValue<S> = S extends Execution<infer O> ? O : never;
export type ReplaySaveCheck<S> = [S] extends [Execution<unknown>] ? unknown : {
  readonly 'Koyuki: replay requires save to return Execution<Output>': never;
};
export type PlainCommand<I, S, F> = {
  readonly run: (input: I) => Promise<Result<S, F>>;
  readonly runDetailed: (input: I) => Promise<ActionReport<S, F>>;
};
export type ReplayCommand<I, S, F, RE> = {
  readonly run: (input: I) => Promise<Result<Execution<ReplayValue<S>>, F | RE | ReplayInputError>>;
  readonly runDetailed: (input: I) => Promise<ReplayReport<ReplayValue<S>, F, RE>>;
};
// Optional or union-valued configuration must expose both possible report formats.
export type SelectCommand<D, Plain, Replayed> = D extends { replay: infer R }
  ? [R] extends [undefined] ? Plain : undefined extends R ? Plain | Replayed : Replayed
  : 'replay' extends keyof D ? Plain | Replayed : Plain;
/** One signature keeps invalid plain declarations out of replay overload diagnostics. */
export function defineUseCase<I, C, LE, V, VE, const T extends readonly AnyStep[], O, E, S, SE, RE, const D extends object>(definition:
  D & Definition<I, C, LE, V, VE, T, O, E, S, SE> & {
    replay?: ReplayBoundary<NoInfer<I>, ReplayValue<NoInfer<S>>, Errors<LE, VE, T, E, SE>, RE> & ReplaySaveCheck<NoInfer<S>>;
  }
): SelectCommand<D,
  PlainCommand<I, S, Errors<LE, VE, T, E, SE>>,
  ReplayCommand<I, S, Errors<LE, VE, T, E, SE>, RE>
>;
/** A composition entry point, not another execution engine. Existing APIs remain usable. */
export function defineUseCase<I, C, LE, V, VE, const T extends readonly AnyStep[], O, E, S, SE, RE>(definition:
  Definition<I, C, LE, V, VE, T, O, E, S, SE> & {
    replay?: ReplayBoundary<I, unknown, Errors<LE, VE, T, E, SE>, RE>;
  }): unknown {
  const command = defineRequestTarget({ operation: definition.operation, loadName: definition.loadName, load: definition.load, save: definition.save }).on(definition.transition);
  if (!definition.replay) return { run: command.run, runDetailed: command.runDetailed };
  // The public signature proves S is Execution<Output>. Erase that envelope only at composition.
  return withReplay(command as unknown as {
    run(input: I): Promise<Result<Execution<unknown>, Errors<LE, VE, T, E, SE>>>;
    runDetailed(input: I): Promise<ActionReport<Execution<unknown>, Errors<LE, VE, T, E, SE>>>;
  }, definition.replay);
}
