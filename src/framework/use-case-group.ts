import type { Result } from './result.js';
import { defineRequestTarget, type RequestExecution, type Step, type TransitionDefinition } from './model.js';
import { withReplay, type Execution, type Receipt } from './replay.js';
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
  const { operation, save } = definition;
  const lookup = definition.replay?.lookup;
  const recovery = definition.replay?.resolveAfter;
  const tags = Array.isArray(recovery) ? new Set<string>(recovery) : null;
  const resolveAfter = (error: unknown): boolean => typeof recovery === 'function' ? recovery(error)
    : !!tags && typeof error === 'object' && error !== null && 'kind' in error && typeof error.kind === 'string' && tags.has(error.kind);
  return {
    on<J extends I, C, LE, V, VE, const T extends readonly AnyStep[], E>(name: N, entry: {
      loadName?: string;
      load: (input: J) => Promise<Result<C, LE>>;
      transition: TransitionDefinition<NoInfer<C>, V, VE, T, NoInfer<O>, E>;
    }): SelectCommand<D,
      PlainCommand<J, S, Errors<LE, VE, T, E, SE>>,
      ReplayCommand<J, S, Errors<LE, VE, T, E, SE>, RE>
    > {
      const id = operation(name);
      const context = (request: J): GroupExecution<N, J> => Object.freeze({ name, operation: id, request });
      const command = defineRequestTarget({ operation: id, loadName: entry.loadName, load: entry.load,
        save: (change: O, execution: RequestExecution<J>) => save(change, context(execution.request)),
      }).on(entry.transition);
      // The adapter chooses recovery by error tag; domain-specific failure unions remain on run.
      const result = lookup ? withReplay(command as unknown as {
        run(input: J): Promise<Result<Execution<Value<S>>, Errors<LE, VE, T, E, SE>>>;
        runDetailed: (input: J) => Promise<import('./action.js').ActionReport<Execution<Value<S>>, Errors<LE, VE, T, E, SE>>>;
      }, {
        lookup: (request: J) => lookup(context(request)),
        resolveAfter,
      }) : { run: command.run, runDetailed: command.runDetailed };
      // replay/save compatibility is checked on the public group definition.
      return result as SelectCommand<D,
        PlainCommand<J, S, Errors<LE, VE, T, E, SE>>,
        ReplayCommand<J, S, Errors<LE, VE, T, E, SE>, RE>
      >;
    },
  };
}
