import { bindDetailed, invokeDetailed, registerDetailed } from './instrumentation.js';
import { observeEffect } from './observation.js';
import type { StageObserver } from './workflow.js';
import { registerStructure, structureOf, structureSequence, loadStructure } from './structure.js';
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
/** Capture adapter methods once; function receivers are bound only when supplied. */
export function captureLoad<I, C, E>(load: ActionLoad<I, C, E>, receiver?: object): ActionLoad<I, C, E> {
  if (typeof load === 'function') return receiver ? load.bind(receiver) : load;
  return registerStructure(Object.freeze({ runDetailed: bindDetailed(load) }), structureOf(load));
}
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
  const load = captureLoad(config.load, config), loadName = config.loadName;
  const mutation = config.mutation, runMutation = bindDetailed(mutation);
  async function execute(input: I, observe?: StageObserver): Promise<ActionReport<O, LE | ME>> {
    let detailLoad!: { result: Result<C, LE>; trace: readonly Trace[] };
    const performLoad = async () => {
      detailLoad = typeof load === 'function' ? { result: await load(input), trace: [] } : await invokeDetailed(load.runDetailed, input, observe);
      return detailLoad.result;
    };
    if (observe) await observeEffect(loadName, input, performLoad, observe); else await performLoad();
    const loaded = detailLoad.result;
    const trace: readonly Trace[] = [...detailLoad.trace, { step: loadName, status: loaded.ok ? 'ok' : 'error' }];
    if (!loaded.ok) return { result: loaded, trace, plan: null };
    const detail = await invokeDetailed(runMutation, loaded.value, observe);
    return { ...detail, trace: [...trace, ...detail.trace] };
  }
  const runDetailed = registerDetailed((input: I) => execute(input), execute);
  async function run(input: I): Promise<Result<O, LE | ME>> { return (await runDetailed(input)).result; }
  return registerStructure({ run, runDetailed }, structureSequence(loadStructure(load, loadName), structureOf(mutation)));
}
