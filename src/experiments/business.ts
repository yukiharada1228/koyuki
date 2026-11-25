// API study only. Not exported by the package and not a second execution engine.
import { defineUseCaseGroup, step, ok, type Result, type Rule, type GroupExecution, type Receipt, type Execution } from '../framework/index.js';
import type { TransitionDefinition } from '../framework/model.js';
import type { PlainCommand, ReplayCommand, ReplaySaveCheck, SelectCommand } from '../framework/use-case.js';
type Fn = Rule<never, unknown, unknown>;
type Load = (input: never) => Promise<Result<unknown, unknown>>;
type Pipeline = readonly [Fn, ...Fn[]];
type Entry = Pipeline | { readonly load: Load; readonly run: Pipeline };
type Input<L> = L extends (input: infer I) => unknown ? I : never;
type Value<R> = R extends { ok: true; value: infer O } ? O : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type Loaded<L extends Load> = Value<Awaited<ReturnType<L>>>;
type LoadError<L extends Load> = Failure<Awaited<ReturnType<L>>>;
type Out<F extends Fn> = Value<ReturnType<F>>;
type ErrorOf<F extends Fn> = Failure<ReturnType<F>>;
type Stages<E extends Entry> = E extends Pipeline ? E : E extends { run: infer P extends Pipeline } ? P : never;
type Loader<L extends Load, E extends Entry> = E extends { load: infer P extends Load } ? P : L;
// Shift stage outputs by one position to check every input without recursive expansion.
// Only the final output is constrained by save; intermediate outputs remain exact.
type Outputs<P extends readonly Fn[]> = { readonly [K in keyof P]: Out<P[K]> };
type Inputs<C, P extends readonly Fn[]> = readonly [C, ...Outputs<P>];
type Tail<P extends readonly Fn[]> = P extends readonly [Fn, ...infer T extends readonly Fn[]] ? T : readonly [];
type Connect<C, P extends readonly Fn[], O> = {
  readonly [K in keyof P]: Rule<Inputs<C, P>[K & keyof Inputs<C, P>], K extends keyof Tail<P> ? Out<P[K]> : O, ErrorOf<P[K]>>
};
type Checked<L extends Load, E extends Entry, O> = E extends Pipeline ? Connect<Loaded<L>, E, O> : E extends { load: infer A extends Load; run: infer P extends Pipeline }
  ? { readonly load: A; readonly run: Connect<Loaded<A>, P, O> } : never;
type Requests<L extends Load, T extends Record<string, Entry>> = { [K in keyof T]: Input<Loader<L, T[K]>> }[keyof T];
type ReplayValue<S> = S extends Execution<infer O> ? O : never;
type Callable<C> = C extends { run: infer R extends (...args: never[]) => unknown } ? R & C : never;
type Commands<L extends Load, T extends Record<string, Entry>, S, SE, RE, D extends object> = {
  readonly [K in keyof T]: Callable<SelectCommand<D,
    PlainCommand<Input<Loader<L, T[K]>>, S, LoadError<Loader<L, T[K]>> | ErrorOf<Stages<T[K]>[number]> | SE>,
    ReplayCommand<Input<Loader<L, T[K]>>, S, LoadError<Loader<L, T[K]>> | ErrorOf<Stages<T[K]>[number]> | SE, RE>
  >>
};
interface RuntimeDefinition {
  name: string;
  load: (input: unknown) => Promise<Result<unknown, unknown>>;
  save: (value: unknown, context: GroupExecution<string, unknown>) => Promise<Result<unknown, unknown>>;
  operations: Record<string, readonly Rule<unknown, unknown, unknown>[] | { load: RuntimeDefinition['load']; run: readonly Rule<unknown, unknown, unknown>[] }>;
  replay?: { lookup: (context: GroupExecution<string, unknown>) => Result<Receipt<unknown>, unknown> | Promise<Result<Receipt<unknown>, unknown>>; resolveAfter: readonly string[] | ((error: unknown) => boolean) };
}
export function business<L extends Load, O, S, SE, RE, const T extends Record<string, Entry>, const D extends object>(definition: D & {
  name: string;
  load: L;
  save: (value: O, context: GroupExecution<Extract<keyof T, string>, Requests<L, T>>) => Promise<Result<S, SE>>;
  // Infer the user tuple first; the compatibility check must not widen it.
  operations: T & NoInfer<{ readonly [K in keyof T]: K extends 'then' ? never : Checked<L, T[K], O> }>;
  replay?: {
    lookup: (context: GroupExecution<Extract<keyof T, string>, Requests<L, T>>) => Result<Receipt<ReplayValue<S>>, RE> | Promise<Result<Receipt<ReplayValue<S>>, RE>>;
    resolveAfter: readonly string[] | ((error: unknown) => boolean);
  } & ReplaySaveCheck<NoInfer<S>>;
}): Commands<L, T, S, SE, RE, D> {
  // Public checks prove adjacency. Only heterogeneous tuple positions are erased here.
  const source = definition as unknown as RuntimeDefinition;
  const config = { operation: (name: string) => `${source.name}.${name}`, save: source.save };
  const group = source.replay
    ? defineUseCaseGroup({ ...config, save: source.save as (value: unknown, context: GroupExecution<string, unknown>) => Promise<Result<Execution<unknown>, unknown>>, replay: source.replay })
    : defineUseCaseGroup(config);
  const commands: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(source.operations)) {
    if (name === 'then') throw new Error('ReservedBusinessOperation:then');
    const custom = 'run' in entry;
    const rules = [...(custom ? entry.run : entry)];
    if (!rules.length) throw new Error('BusinessRequiresRule');
    const first = rules[0]!;
    // Single-rule operations still use the same transition engine; identity is explicit in trace.
    const normalized = rules.length === 1
      ? { validate: step('run:1', first), require: [], evolve: step('complete', (value: unknown) => ok(value)) }
      : { validate: step('run:1', first), require: rules.slice(1, -1).map((rule, index) => step(`run:${index + 2}`, rule)), evolve: step(`run:${rules.length}`, rules.at(-1)!) };
    const command = group.on(name, { load: custom ? entry.load : source.load,
      transition: normalized as unknown as TransitionDefinition<unknown, unknown, unknown, readonly [], unknown, unknown> });
    const run = (input: unknown) => command.run(input);
    // Works both as expense.approve(input) and as a command for operations(...).
    Object.defineProperty(commands, name, { value: Object.freeze(Object.assign(run, command)), enumerable: true });
  }
  return Object.freeze(commands) as Commands<L, T, S, SE, RE, D>;
}
