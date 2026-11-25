import { snapshotData } from './snapshot.js';
import { defineProgram, next, effect } from './program.js';
import { ok, err, type Result } from './result.js';
export interface Operation<S, I, O, E> {
  readonly run: (input: I) => Promise<Result<O, E>>;
  readonly reduce: (state: S, output: O) => S;
}
export function operation<S, I, O, E>(command: { readonly run: (input: I) => Promise<Result<O, E>> }, reduce: (state: S, output: NoInfer<O>) => S): Operation<S, I, O, E> {
  return { run: command.run.bind(command), reduce };
}
type CommandInput<T> = T extends { run(input: infer I): unknown } ? I : never;
type CommandOutput<T> = T extends { run(input: never): Promise<Result<infer O, unknown>> } ? O : never;
type CommandError<T> = T extends { run(input: never): Promise<Result<unknown, infer E>> } ? E : never;
/** Apply one projection rule to a command table while preserving each command's signature. */
export function operations<S, const T extends Record<string, {
  run(input: never): Promise<Result<unknown, unknown>>;
}>>(commands: T, reduce: (state: S, output: CommandOutput<T[keyof T]>) => S): {
  [K in keyof T]: Operation<S, CommandInput<T[K]>, CommandOutput<T[K]>, CommandError<T[K]>>
} {
  const entries = Object.entries(commands).map(([key, command]) => [key,
    operation(command, reduce as (state: S, output: unknown) => S),
  ]);
  return Object.fromEntries(entries) as {
    [K in keyof T]: Operation<S, CommandInput<T[K]>, CommandOutput<T[K]>, CommandError<T[K]>>
  };
}
type AnyOperation<S> = { run(input: never): Promise<Result<unknown, unknown>>; reduce(state: S, output: never): S };
type Input<T> = T extends { run(input: infer I): unknown } ? I : never;
type ErrorOf<T> = T extends { run(input: never): Promise<Result<unknown, infer E>> } ? E : never;
type Key<T> = Extract<keyof T, string>;
export type ApplicationEvent<T> = { [K in Key<T>]: { readonly type: K; readonly input: Input<T[K]> } }[Key<T>] | { readonly type: 'dismiss' };
export interface UnexpectedException { readonly kind: 'UnexpectedException'; readonly message: string }
function unexpectedException(cause: unknown): UnexpectedException {
  try {
    return { kind: 'UnexpectedException', message: cause instanceof Error ? String(cause.message) : typeof cause === 'string' ? cause : 'Operation threw an unexpected value' };
  } catch { return { kind: 'UnexpectedException', message: 'Operation threw an unexpected value' }; }
}
export type ApplicationState<S, T> =
  | { readonly kind: 'ready'; readonly data: S }
  | { readonly kind: 'running'; readonly data: S; readonly operation: Key<T> }
  | { readonly kind: 'crashed'; readonly data: S; readonly operation: Key<T>; readonly error: UnexpectedException }
  | { [K in Key<T>]: { readonly kind: 'failed'; readonly data: S; readonly operation: K; readonly error: ErrorOf<T[K]> } }[Key<T>];
/** Standard operation lifecycle belongs to the framework, not each business application. */
export function defineApplication<S, const T extends Record<string, AnyOperation<S>>, V>(definition: {
  initial: () => S; operations: T; view: (state: ApplicationState<S, T>) => V;
}) {
  type State = ApplicationState<S, T>;
  type PublicEvent = ApplicationEvent<T>;
  type Crash = { type: '@crash'; operation: Key<T>; error: UnexpectedException };
  type Completion = { type: '@complete'; operation: Key<T>; result: Result<unknown, unknown> };
  type InternalEvent = { type: '@execute'; operation: Key<T>; input: unknown } | Completion | Crash | { type: 'dismiss' };
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
        const command = effect(event.operation, async (input: unknown): Promise<Completion | Crash> => {
          try { return { type: '@complete', operation: event.operation, result: await run(input) }; }
          catch (cause) { return { type: '@crash', operation: event.operation, error: unexpectedException(cause) }; }
        }, message => message);
        return ok(next<State, InternalEvent>({ kind: 'running', operation: event.operation, data: state.data }, command(event.input)));
      }
      if (state.kind === 'running' && event.type === '@crash' && event.operation === state.operation) {
        return ok(next<State, InternalEvent>({ kind: 'crashed', data: state.data, operation: event.operation, error: event.error }));
      }
      if (state.kind === 'running' && event.type === '@complete' && event.operation === state.operation) {
        if (!event.result.ok) {
          // This private completion is generated only by the selected operation's command.
          try {
            const error = snapshotData(event.result.error);
            return ok(next<State, InternalEvent>({ kind: 'failed', data: state.data, operation: event.operation, error } as State));
          } catch (cause) {
            return ok(next<State, InternalEvent>({ kind: 'crashed', data: state.data, operation: event.operation, error: unexpectedException(cause) }));
          }
        }
        const reduce = operations[event.operation]!.reduce as (state: S, output: unknown) => S;
        try {
          const data = snapshotData(reduce(snapshotData(state.data), event.result.value));
          return ok(next<State, InternalEvent>({ kind: 'ready', data }));
        } catch (cause) {
          return ok(next<State, InternalEvent>({ kind: 'crashed', data: state.data, operation: event.operation, error: unexpectedException(cause) }));
        }
      }
      if ((state.kind === 'failed' || state.kind === 'crashed') && event.type === 'dismiss') return ok(next<State, InternalEvent>({ kind: 'ready', data: state.data }));
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
          // Validate before reading routing properties or deriving the private event.
          try { event = snapshotData(event); }
          catch (cause) { return Promise.reject(cause); }
          if (event.type === 'dismiss') return session.dispatch({ type: 'dismiss' }, expectedRevision);
          // Reject forged completion events even from untyped JS callers.
          if (!Object.hasOwn(operations, event.type)) return Promise.resolve(err({ kind: 'UnexpectedMessage' as const }));
          return session.dispatch({ type: '@execute', operation: event.type, input: (event as { input: unknown }).input }, expectedRevision);
        },
      };
    },
  };
}
