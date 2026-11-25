import { registerStructure, structureOf, structureSequence, structureStep, emptyStructure } from './structure.js';
import { ok, type Result } from './result.js';
import { observeEvaluation, type Workflow, type Trace, type StageObserver, type WorkflowCapture } from './workflow.js';
import { createObservation, type ObservationReport } from './observation.js';
import type { ActionReport } from './action.js';
interface Report<O, E> { readonly result: Result<O, E>; readonly trace: readonly Trace[] }
/** Capture overload first: ordinary loader/command ReturnType remains ActionReport. */
function detailed<I, O, E>(perform: (input: I, observe?: StageObserver) => Promise<ActionReport<O, E>>) {
  function runDetailed<A, B>(input: I, capture: WorkflowCapture<A, B>): Promise<ActionReport<O, E> & ObservationReport<A, B>>;
  function runDetailed(input: I): Promise<ActionReport<O, E>>;
  async function runDetailed<A, B>(input: I, capture?: WorkflowCapture<A, B>) {
    if (!capture) return perform(input);
    const recorder = createObservation(capture);
    return { ...await perform(input, recorder.observe), ...recorder.report() };
  }
  return runDetailed;
}
/** IO orchestration is intentionally separate from the synchronous, pure Workflow API. */
class Process<I, O, E> {
  constructor(private readonly evaluate: (input: I, observe?: StageObserver) => Promise<Report<O, E>>) {
    this.runDetailed = detailed(async (input: I, observe) => ({ ...await evaluate(input, observe), plan: null }));
  }
  /** Execute once; optional selected-value capture is isolated from business failures. */
  readonly runDetailed: ReturnType<typeof detailed<I, O, E>>;
  readonly run = async (input: I): Promise<Result<O, E>> => (await this.runDetailed(input)).result;
  through<N, F>(flow: Workflow<O, N, F> & { readonly run: (value: O) => Result<N, F> }): Process<I, N, E | F> {
    return registerStructure(new Process<I, N, E | F>(async (input, observe) => {
      const prior = await this.evaluate(input, observe);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace };
      const next = observe ? flow[observeEvaluation](prior.result.value, observe) : flow.inspect(prior.result.value);
      return { result: next.result, trace: [...prior.trace, ...next.trace] };
    }), structureSequence(structureOf(this), structureOf(flow)));
  }
  /** An explicit IO boundary; the adapter returns the next workflow's complete input. */
  effect<N, F>(name: string, perform: ((value: O) => Promise<Result<N, F>>) | { readonly runDetailed: (value: O) => Promise<ActionReport<N, F>> }): Process<I, N, E | F> {
    return registerStructure(new Process<I, N, E | F>(async (input, observe) => {
      const prior = await this.evaluate(input, observe);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace };
      const receive = observe?.(name, prior.result.value);
      // A function keeps its original opaque IO contract. The object form opts into detail.
      const detail = typeof perform === 'function'
        ? { result: await perform(prior.result.value), trace: [] }
        : await perform.runDetailed(prior.result.value);
      const { result } = detail;
      receive?.(result);
      return { result, trace: [...prior.trace, ...detail.trace, { step: name, status: result.ok ? 'ok' : 'error' }] };
    }), structureSequence(structureOf(this), ...(typeof perform === 'function' ? [] : [structureOf(perform)]), structureStep(name, 'effect')));
  }
  /** The bound mutation owns its pure final decision and single save. */
  commit<S, F>(mutation: { readonly runDetailed: (input: NoInfer<O>) => Promise<ActionReport<S, F>> }) {
    const evaluate = this.evaluate;
    const runDetailed = detailed(async (input: I, observe): Promise<ActionReport<S, E | F>> => {
      const prior = await evaluate(input, observe);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace, plan: null };
      const receive = observe?.('commit', prior.result.value);
      const next = await mutation.runDetailed(prior.result.value);
      receive?.(next.result);
      return { ...next, trace: [...prior.trace, ...next.trace] };
    });
    async function run(input: I): Promise<Result<S, E | F>> { return (await runDetailed(input)).result; }
    return registerStructure({ run, runDetailed }, structureSequence(structureOf(this), structureOf(mutation)));
  }
}
/** A process executes effects on run; it has no pretend-pure prepare/inspect API. */
export function process<I>() {
  return registerStructure(new Process<I, I, never>(async input => ({ result: ok(input), trace: [] })), emptyStructure);
}
