import type { ActionLoad } from './action.js';
// Internal composition shared by declared transitions and the unpublished API study.
import type { Result } from './result.js';
import type { Workflow } from './workflow.js';
import { defineCommand } from './command.js';
import { withReplay, type Execution, type Receipt } from './replay.js';
import type { GroupExecution } from './use-case-group.js';
import type { PlainCommand, ReplayCommand, ReplaySaveCheck, SelectCommand } from './use-case.js';
type Value<S> = S extends Execution<infer O> ? O : never;
export function createGroupRuntime<N extends string, I, O, S, SE, RE, const D extends object>(definition: D & {
  operation: (name: N) => string;
  save: (change: O, execution: GroupExecution<N, I>) => Promise<Result<S, SE>>;
  replay?: {
    lookup: (execution: GroupExecution<N, I>) => Result<Receipt<Value<S>>, RE> | Promise<Result<Receipt<Value<S>>, RE>>;
    resolveAfter: readonly string[] | ((error: unknown) => boolean);
  } & ReplaySaveCheck<NoInfer<S>>;
}) {
  const { operation, save } = definition;
  const lookup = definition.replay?.lookup;
  const recovery = definition.replay?.resolveAfter;
  const tags = Array.isArray(recovery) ? new Set<string>(recovery) : null;
  const resolveAfter = (error: unknown): boolean => typeof recovery === 'function' ? recovery(error)
    : !!tags && typeof error === 'object' && error !== null && 'kind' in error && typeof error.kind === 'string' && tags.has(error.kind);
  return {
    on<J extends I, C, LE, DE>(name: N, entry: {
      loadName?: string;
      load: ActionLoad<J, C, LE>;
      decide: Workflow<NoInfer<C>, NoInfer<O>, DE>;
    }): SelectCommand<D, PlainCommand<J, S, LE | DE | SE>, ReplayCommand<J, S, LE | DE | SE, RE>> {
      const id = operation(name);
      const context = (request: J): GroupExecution<N, J> => Object.freeze({ name, operation: id, request });
      const forRequest = (request: J) => defineCommand({ operation: id, loadName: entry.loadName, load: entry.load,
        decide: entry.decide, save: (change: O) => save(change, context(request)) });
      const command = {
        run: (request: J) => forRequest(request).run(request),
        runDetailed: (request: J) => forRequest(request).runDetailed(request),
      };
      // The public definition checks the persisted Execution envelope when replay is enabled.
      const result = lookup ? withReplay(command as unknown as {
        run(input: J): Promise<Result<Execution<Value<S>>, LE | DE | SE>>;
        runDetailed(input: J): Promise<import('./action.js').ActionReport<Execution<Value<S>>, LE | DE | SE>>;
      }, { lookup: (request: J) => lookup(context(request)), resolveAfter }) : command;
      return result as SelectCommand<D, PlainCommand<J, S, LE | DE | SE>, ReplayCommand<J, S, LE | DE | SE, RE>>;
    },
  };
}
