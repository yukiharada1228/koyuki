import { ok, type Result } from './result.js';
import type { Workflow, Trace } from './workflow.js';
import type { ActionReport } from './action.js';
interface Report<O, E> { readonly result: Result<O, E>; readonly trace: readonly Trace[] }
/** IO orchestration is intentionally separate from the synchronous, pure Workflow API. */
class Process<I, O, E> {
  constructor(private readonly evaluate: (input: I) => Promise<Report<O, E>>) {}
  /** Execute the declared effects without requiring an artificial final mutation. */
  readonly runDetailed = async (input: I): Promise<ActionReport<O, E>> => {
    const report = await this.evaluate(input);
    return { ...report, plan: null };
  };
  readonly run = async (input: I): Promise<Result<O, E>> => (await this.runDetailed(input)).result;
  through<N, F>(flow: Workflow<O, N, F>): Process<I, N, E | F> {
    return new Process<I, N, E | F>(async input => {
      const prior = await this.evaluate(input);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace };
      const next = flow.inspect(prior.result.value);
      return { result: next.result, trace: [...prior.trace, ...next.trace] };
    });
  }
  /** An explicit IO boundary; the adapter returns the next workflow's complete input. */
  effect<N, F>(name: string, perform: ((value: O) => Promise<Result<N, F>>) | { runDetailed(value: O): Promise<ActionReport<N, F>> }): Process<I, N, E | F> {
    return new Process<I, N, E | F>(async input => {
      const prior = await this.evaluate(input);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace };
      // A function keeps its original opaque IO contract. The object form opts into detail.
      const detail = typeof perform === 'function'
        ? { result: await perform(prior.result.value), trace: [] }
        : await perform.runDetailed(prior.result.value);
      const { result } = detail;
      return { result, trace: [...prior.trace, ...detail.trace, { step: name, status: result.ok ? 'ok' : 'error' }] };
    });
  }
  /** The bound mutation owns its pure final decision and single save. */
  commit<S, F>(mutation: { runDetailed(input: NoInfer<O>): Promise<ActionReport<S, F>> }) {
    const evaluate = this.evaluate;
    async function runDetailed(input: I): Promise<ActionReport<S, E | F>> {
      const prior = await evaluate(input);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace, plan: null };
      const next = await mutation.runDetailed(prior.result.value);
      return { ...next, trace: [...prior.trace, ...next.trace] };
    }
    async function run(input: I): Promise<Result<S, E | F>> { return (await runDetailed(input)).result; }
    return { run, runDetailed };
  }
}
/** A process executes effects on run; it has no pretend-pure prepare/inspect API. */
export function process<I>() {
  return new Process<I, I, never>(async input => ({ result: ok(input), trace: [] }));
}
