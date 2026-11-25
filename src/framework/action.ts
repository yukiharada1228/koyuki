import type { Result } from './result.js';
import type { Trace } from './workflow.js';
export interface ActionReport<O, E> {
  readonly result: Result<O, E>;
  readonly trace: readonly Trace[];
  readonly plan: unknown;
}
export type ActionLoad<I, C, E> = ((input: I) => Promise<Result<C, E>>) | {
  readonly runDetailed: (input: I) => Promise<ActionReport<C, E>>;
};
type Loader = ActionLoad<never, unknown, unknown>;
type LoadResult<L> = L extends (input: never) => infer R ? Awaited<R>
  : L extends { runDetailed: (input: never) => infer D } ? Awaited<D> extends { result: infer R } ? R : never : never;
type Value<R> = R extends { ok: true; value: infer C } ? C : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type Loaded<L> = Value<LoadResult<L>>;
type LoadError<L> = Failure<LoadResult<L>>;
// A dynamically selected loader must accept the request in every possible branch.
type LoadCall<L> = L extends (input: never) => unknown ? L : L extends { runDetailed: infer F } ? F : never;
type LoadInput<L> = [LoadCall<L>] extends [(input: infer I) => unknown] ? I : never;
/** Infer the loader before checking that the mutation accepts every loaded value. */
export function defineAction<L extends object, O, ME>(config: {
  loadName: string;
  load: L & NoInfer<[L] extends [Loader] ? unknown : never>;
  mutation: { readonly runDetailed: (input: NoInfer<Loaded<L>>) => Promise<ActionReport<O, ME>> };
}): {
  run: (input: LoadInput<L>) => Promise<Result<O, LoadError<L> | ME>>;
  runDetailed: (input: LoadInput<L>) => Promise<ActionReport<O, LoadError<L> | ME>>;
};
/** Preserve explicit type arguments while checking the consumer contravariantly. */
export function defineAction<I, C, LE, O, ME>(config: {
  loadName: string;
  load: ActionLoad<I, C, LE>;
  mutation: { readonly runDetailed: (input: NoInfer<C>) => Promise<ActionReport<O, ME>> };
}): {
  run: (input: I) => Promise<Result<O, LE | ME>>;
  runDetailed: (input: I) => Promise<ActionReport<O, LE | ME>>;
};
/** Connect host-owned IO to a typed mutation; execute each phase exactly once. */
export function defineAction<I, C, LE, O, ME>(config: {
  loadName: string;
  load: ActionLoad<I, C, LE>;
  mutation: { runDetailed(input: C): Promise<ActionReport<O, ME>> };
}) {
  async function runDetailed(input: I): Promise<ActionReport<O, LE | ME>> {
    const detailLoad = typeof config.load === 'function'
      ? { result: await config.load(input), trace: [] }
      : await config.load.runDetailed(input);
    const loaded = detailLoad.result;
    const trace: readonly Trace[] = [...detailLoad.trace, { step: config.loadName, status: loaded.ok ? 'ok' : 'error' }];
    if (!loaded.ok) return { result: loaded, trace, plan: null };
    const detail = await config.mutation.runDetailed(loaded.value);
    return { ...detail, trace: [...trace, ...detail.trace] };
  }
  async function run(input: I): Promise<Result<O, LE | ME>> { return (await runDetailed(input)).result; }
  return { run, runDetailed };
}
