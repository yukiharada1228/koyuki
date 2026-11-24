import { defineProgram, next, effect } from './program.js';
import { ok, err, type Result } from './result.js';
export interface Operation<S, I, O, E> {
  readonly run: (input: I) => Promise<Result<O, E>>;
  readonly reduce: (state: S, output: O) => S;
}
export function operation<S, I, O, E>(command: { run(input: I): Promise<Result<O, E>> }, reduce: (state: S, output: NoInfer<O>) => S): Operation<S, I, O, E> {
  return { run: command.run, reduce };
}
type AnyOperation<S> = { run(input: never): Promise<Result<unknown, unknown>>; reduce(state: S, output: never): S };
type Input<T> = T extends { run(input: infer I): unknown } ? I : never;
type ErrorOf<T> = T extends { run(input: never): Promise<Result<unknown, infer E>> } ? E : never;
type Key<T> = Extract<keyof T, string>;
export type ApplicationEvent<T> = { [K in Key<T>]: { readonly type: K; readonly input: Input<T[K]> } }[Key<T>] | { readonly type: 'dismiss' };
export type ApplicationState<S, T> =
  | { readonly kind: 'ready'; readonly data: S }
  | { readonly kind: 'running'; readonly data: S; readonly operation: Key<T> }
  | { [K in Key<T>]: { readonly kind: 'failed'; readonly data: S; readonly operation: K; readonly error: ErrorOf<T[K]> } }[Key<T>];
/** Standard operation lifecycle belongs to the framework, not each business application. */
export function defineApplication<S, const T extends Record<string, AnyOperation<S>>, V>(definition: {
  initial: () => S; operations: T; view: (state: ApplicationState<S, T>) => V;
}) {
  type State = ApplicationState<S, T>;
  type PublicEvent = ApplicationEvent<T>;
  type Completion = { type: '@complete'; operation: Key<T>; result: Result<unknown, unknown> };
  type InternalEvent = { type: '@execute'; operation: Key<T>; input: unknown } | Completion | { type: 'dismiss' };
  for (const key of Object.keys(definition.operations)) if (key === 'dismiss' || key.startsWith('@')) throw new Error('ReservedOperationName');
  const operations = { ...definition.operations };
  const program = defineProgram({
    init: () => next<State, InternalEvent>({ kind: 'ready', data: definition.initial() }),
    update(state: State, event: InternalEvent) {
      if (state.kind === 'ready' && event.type === '@execute') {
        const entry = operations[event.operation];
        if (!entry) return err({ kind: 'UnexpectedMessage' as const });
        // Public dispatch has already selected a type-checked operation/input pair.
        const run = entry.run as (input: unknown) => Promise<Result<unknown, unknown>>;
        const command = effect(event.operation, run, (result): InternalEvent => ({ type: '@complete', operation: event.operation, result }));
        return ok(next<State, InternalEvent>({ kind: 'running', operation: event.operation, data: state.data }, command(event.input)));
      }
      if (state.kind === 'running' && event.type === '@complete' && event.operation === state.operation) {
        if (!event.result.ok) {
          // This private completion is generated only by the selected operation's command.
          return ok(next<State, InternalEvent>({ kind: 'failed', data: state.data, operation: event.operation, error: event.result.error } as State));
        }
        const reduce = operations[event.operation]!.reduce as (state: S, output: unknown) => S;
        return ok(next<State, InternalEvent>({ kind: 'ready', data: reduce(state.data, event.result.value) }));
      }
      if (state.kind === 'failed' && event.type === 'dismiss') return ok(next<State, InternalEvent>({ kind: 'ready', data: state.data }));
      return err({ kind: 'UnexpectedMessage' as const });
    },
    view: definition.view,
  });
  return {
    initial: () => program.init().state,
    view: definition.view,
    async start() {
      const session = await program.start();
      return {
        snapshot: session.snapshot, subscribe: session.subscribe, trace: session.trace,
        dispatch(event: PublicEvent, expectedRevision?: number) {
          if (event.type === 'dismiss') return session.dispatch({ type: 'dismiss' }, expectedRevision);
          // Reject forged completion events even from untyped JS callers.
          if (!Object.hasOwn(operations, event.type)) return Promise.resolve(err({ kind: 'UnexpectedMessage' as const }));
          return session.dispatch({ type: '@execute', operation: event.type, input: (event as { input: unknown }).input }, expectedRevision);
        },
      };
    },
  };
}
