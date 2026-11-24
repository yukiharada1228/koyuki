import type { Result } from './result.js';
import type { ActionReport } from './action.js';
import { defineRequestTarget, type RequestExecution, type Step, type TransitionDefinition } from './model.js';
import { withReplay, type Execution, type ReplayBoundary, type ReplayInputError, type ReplayReport } from './replay.js';
type AnyStep = Step<never, unknown, unknown>;
type Failure<T> = T extends Step<never, unknown, infer E> ? E : never;
type Errors<LE, VE, T extends readonly AnyStep[], E, SE> = LE | VE | Failure<T[number]> | E | SE;
type Definition<I, C, LE, V, VE, T extends readonly AnyStep[], O, E, S, SE> = {
  operation: string;
  loadName?: string;
  load: (input: I) => Promise<Result<C, LE>>;
  transition: TransitionDefinition<NoInfer<C>, V, VE, T, O, E>;
  save: (change: NoInfer<O>, execution: RequestExecution<NoInfer<I>>) => Promise<Result<S, SE>>;
};
export function defineUseCase<I, C, LE, V, VE, const T extends readonly AnyStep[], O, E, S, SE>(definition:
  Definition<I, C, LE, V, VE, T, O, E, S, SE> & { replay?: undefined }): {
    run(input: I): Promise<Result<S, Errors<LE, VE, T, E, SE>>>;
    runDetailed(input: I): Promise<ActionReport<S, Errors<LE, VE, T, E, SE>>>;
  };
export function defineUseCase<I, C, LE, V, VE, const T extends readonly AnyStep[], O, E, S, SE, RE>(definition:
  Definition<I, C, LE, V, VE, T, O, E, Execution<S>, SE> & {
    replay: ReplayBoundary<NoInfer<I>, NoInfer<S>, NoInfer<Errors<LE, VE, T, E, SE>>, RE>;
  }): {
    run(input: I): Promise<Result<Execution<S>, Errors<LE, VE, T, E, SE> | RE | ReplayInputError>>;
    runDetailed(input: I): Promise<ReplayReport<S, Errors<LE, VE, T, E, SE>, RE>>;
  };
/** A composition entry point, not another execution engine. Existing APIs remain usable. */
export function defineUseCase<I, C, LE, V, VE, const T extends readonly AnyStep[], O, E, S, SE, RE>(definition:
  Definition<I, C, LE, V, VE, T, O, E, S, SE> & {
    replay?: ReplayBoundary<I, unknown, Errors<LE, VE, T, E, SE>, RE>;
  }): unknown {
  const command = defineRequestTarget({ operation: definition.operation, loadName: definition.loadName, load: definition.load, save: definition.save }).on(definition.transition);
  if (!definition.replay) return { run: command.run, runDetailed: command.runDetailed };
  // The replay overload proves S is Execution<Output>. Erase that envelope only at composition.
  return withReplay(command as unknown as {
    run(input: I): Promise<Result<Execution<unknown>, Errors<LE, VE, T, E, SE>>>;
    runDetailed(input: I): Promise<ActionReport<Execution<unknown>, Errors<LE, VE, T, E, SE>>>;
  }, definition.replay);
}
