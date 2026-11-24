import type { Result } from './result.js';
import type { Trace } from './workflow.js';
export interface ActionReport<O, E> {
  readonly result: Result<O, E>;
  readonly trace: readonly Trace[];
  readonly plan: unknown;
}
/** Connect host-owned IO to a typed mutation; execute each phase exactly once. */
export function defineAction<I, C, LE, O, ME>(config: {
  loadName: string;
  load: (input: I) => Promise<Result<C, LE>>;
  mutation: { runDetailed(input: NoInfer<C>): Promise<ActionReport<O, ME>> };
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
