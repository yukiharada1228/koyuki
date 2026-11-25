import { bindDetailed, invokeDetailed, registerDetailed } from './instrumentation.js';
import { registerStructure, structureOf, structureSequence, structureStep, emptyStructure } from './structure.js';
import { ok, type Result } from './result.js';
import { observeEvaluation, type Workflow, type Evaluation, type Trace, type StageObserver, type WorkflowCapture } from './workflow.js';
import { createObservation, type ObservationReport } from './observation.js';
import { captureLoad, type ActionReport } from './action.js';
interface Report<O, E> { readonly result: Result<O, E>; readonly trace: readonly Trace[] }
type Effect<I, O, E> = ((value: I) => Promise<Result<O, E>>) | { readonly runDetailed: (value: I) => Promise<ActionReport<O, E>> };
/** Capture overload first: ordinary loader/command ReturnType remains ActionReport. */
function detailed<I, O, E>(perform: (input: I, observe?: StageObserver) => Promise<ActionReport<O, E>>) {
  function runDetailed<A, B>(input: I, capture: WorkflowCapture<A, B>): Promise<ActionReport<O, E> & ObservationReport<A, B>>;
  function runDetailed(input: I): Promise<ActionReport<O, E>>;
  async function runDetailed<A, B>(input: I, capture?: WorkflowCapture<A, B>) {
    if (!capture) return perform(input);
    const recorder = createObservation(capture);
    return { ...await perform(input, recorder.observe), ...recorder.report() };
  }
  return registerDetailed(runDetailed, perform);
}
/** IO orchestration is intentionally separate from the synchronous, pure Workflow API. */
class Process<I, O, E> {
  constructor(private readonly evaluate: (input: I, observe?: StageObserver) => Promise<Report<O, E>>) {
    const runDetailed = detailed(async (input: I, observe) => ({ ...await evaluate(input, observe), plan: null }));
    this.runDetailed = runDetailed;
    this.run = async (input: I): Promise<Result<O, E>> => (await runDetailed(input)).result;
  }
  /** Execute once; optional selected-value capture is isolated from business failures. */
  readonly runDetailed: ReturnType<typeof detailed<I, O, E>>;
  readonly run: (input: I) => Promise<Result<O, E>>;
  through<N, F>(flow: Workflow<O, N, F> & { readonly run: (value: O) => Result<N, F> }): Process<I, N, E | F> {
    const inspect: (input: O) => Evaluation<N, F> = flow.inspect.bind(flow);
    const observed = flow[observeEvaluation];
    return registerStructure(new Process<I, N, E | F>(async (input, observe) => {
      const prior = await this.evaluate(input, observe);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace };
      const next = observe ? observed(prior.result.value, observe) : inspect(prior.result.value);
      return { result: next.result, trace: [...prior.trace, ...next.trace] };
    }), structureSequence(structureOf(this), structureOf(flow)));
  }
  /** Explicitly construct the next input from the prior context and successful IO value. */
  effect<N, F, P>(name: string, perform: Effect<O, N, F>, project: (context: O, value: NoInfer<N>) => P): Process<I, P, E | F>;
  /** Without a projector, the adapter returns the next workflow's complete input. */
  effect<N, F>(name: string, perform: Effect<O, N, F>): Process<I, N, E | F>;
  effect<N, F, P>(name: string, perform: Effect<O, N, F>, project?: (context: O, value: NoInfer<N>) => P): Process<I, N | P, E | F> {
    const effect = captureLoad(perform);
    return registerStructure(new Process<I, N | P, E | F>(async (input, observe) => {
      const prior = await this.evaluate(input, observe);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace };
      const receive = observe?.(name, prior.result.value);
      // A function keeps its original opaque IO contract. The object form opts into detail.
      let detail: Report<N, F>, result: Result<N | P, F>;
      try { detail = typeof effect === 'function'
        ? { result: await effect(prior.result.value), trace: [] }
        : await invokeDetailed(effect.runDetailed, prior.result.value, observe);
        result = detail.result.ok && project ? ok(project(prior.result.value, detail.result.value)) : detail.result;
      } catch (cause) { try { receive?.defect?.(); } catch {} throw cause; }
      receive?.(result);
      return { result, trace: [...prior.trace, ...detail.trace, { step: name, status: result.ok ? 'ok' : 'error' }] };
    }), structureSequence(structureOf(this), ...(typeof effect === 'function' ? [] : [structureOf(effect)]), structureStep(name, 'effect')));
  }
  /** The bound mutation owns its pure final decision and single save. */
  commit<S, F>(mutation: { readonly runDetailed: (input: NoInfer<O>) => Promise<ActionReport<S, F>> }) {
    const evaluate = this.evaluate, commit = bindDetailed(mutation);
    const runDetailed = detailed(async (input: I, observe): Promise<ActionReport<S, E | F>> => {
      const prior = await evaluate(input, observe);
      if (!prior.result.ok) return { result: prior.result, trace: prior.trace, plan: null };
      const receive = observe?.('commit', prior.result.value);
      let next: ActionReport<S, F>;
      try { next = await invokeDetailed(commit, prior.result.value, observe); }
      catch (cause) { try { receive?.defect?.(); } catch {} throw cause; }
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
