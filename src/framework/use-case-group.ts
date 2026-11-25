import type { ActionLoad } from './action.js';
import type { Result } from './result.js';
import { transition, type RequestExecution, type Step, type TransitionDefinition } from './model.js';
import type { Execution, Receipt } from './replay.js';
import { createGroupRuntime } from './group-runtime.js';
import type { Errors, PlainCommand, ReplayCommand, ReplaySaveCheck, SelectCommand } from './use-case.js';

type AnyStep = Step<never, unknown, unknown>;
type Value<S> = S extends Execution<infer O> ? O : never;
/** A business operation key and its stable external identifier are distinct. */
export interface GroupExecution<N extends string, I> extends RequestExecution<I> {
  readonly name: N;
}
/** Bind a shared IO policy once, then attach independently typed business operations.
 * Loading stays operation-specific so required input fields cannot disappear in a union.
 */
export function defineUseCaseGroup<N extends string, I, O, S, SE, RE, const D extends object>(definition:
  D & {
    operation: (name: N) => string;
    save: (change: O, execution: GroupExecution<N, I>) => Promise<Result<S, SE>>;
    replay?: {
      lookup: (execution: GroupExecution<N, I>) => Result<Receipt<Value<S>>, RE> | Promise<Result<Receipt<Value<S>>, RE>>;
      resolveAfter: readonly string[] | ((error: unknown) => boolean);
    } & ReplaySaveCheck<NoInfer<S>>;
  }
) {
  const runtime = createGroupRuntime<N, I, O, S, SE, RE, D>(definition);
  return {
    on<J extends I, C, LE, V, VE, const T extends readonly AnyStep[], E>(name: N, entry: {
      loadName?: string;
      load: ActionLoad<J, C, LE>;
      transition: TransitionDefinition<NoInfer<C>, V, VE, T, NoInfer<O>, E>;
    }): SelectCommand<D,
      PlainCommand<J, S, Errors<LE, VE, T, E, SE>>,
      ReplayCommand<J, S, Errors<LE, VE, T, E, SE>, RE>
    > {
      return runtime.on(name, { loadName: entry.loadName, load: entry.load, decide: transition<C, V, VE, T, O, E>(entry.transition) });
    },
  };
}
