import type { Result } from './result.js';
import type { Trace } from './workflow.js';
export interface ActionReport<O, E> {
  readonly result: Result<O, E>;
  readonly trace: readonly Trace[];
  readonly plan: unknown;
}
type Loader = (input: never) => Promise<Result<unknown, unknown>>;
type Value<R> = R extends { ok: true; value: infer C } ? C : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type Loaded<L> = L extends Loader ? Value<Awaited<ReturnType<L>>> : never;
type LoadError<L> = L extends Loader ? Failure<Awaited<ReturnType<L>>> : never;
type LoadInput<L> = L extends Loader ? Parameters<L>[0] : never;
/** Infer the loader before checking that the mutation accepts every loaded value. */
export function defineAction<L extends object, O, ME>(config: {
  loadName: string;
  load: L & NoInfer<L extends Loader ? unknown : never>;
  mutation: { readonly runDetailed: (input: NoInfer<Loaded<L>>) => Promise<ActionReport<O, ME>> };
}): {
  run: (input: LoadInput<L>) => Promise<Result<O, LoadError<L> | ME>>;
  runDetailed: (input: LoadInput<L>) => Promise<ActionReport<O, LoadError<L> | ME>>;
};
/** Preserve explicit type arguments while checking the consumer contravariantly. */
export function defineAction<I, C, LE, O, ME>(config: {
  loadName: string;
  load: (input: I) => Promise<Result<C, LE>>;
  mutation: { readonly runDetailed: (input: NoInfer<C>) => Promise<ActionReport<O, ME>> };
}): {
  run: (input: I) => Promise<Result<O, LE | ME>>;
  runDetailed: (input: I) => Promise<ActionReport<O, LE | ME>>;
};
/** Connect host-owned IO to a typed mutation; execute each phase exactly once. */
export function defineAction<I, C, LE, O, ME>(config: {
  loadName: string;
  load: (input: I) => Promise<Result<C, LE>>;
  mutation: { runDetailed(input: C): Promise<ActionReport<O, ME>> };
}) {
  async function runDetailed(input: I): Promise<ActionReport<O, LE | ME>> {
    const loaded = await config.load(input);
    if (!loaded.ok) return { result: loaded, trace: [{ step: config.loadName, status: 'error' }], plan: null };
    const detail = await config.mutation.runDetailed(loaded.value);
    return { ...detail, trace: [{ step: config.loadName, status: 'ok' }, ...detail.trace] };
  }
  async function run(input: I): Promise<Result<O, LE | ME>> { return (await runDetailed(input)).result; }
  return { run, runDetailed };
}
