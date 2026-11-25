import type { Result } from './result.js';
import type { WorkflowCapture, StepObservation, StageObserver } from './workflow.js';
export interface CaptureFailure { readonly step: string; readonly phase: 'input' | 'result'; readonly kind: 'CaptureFailed' }
export interface ObservationReport<I, R> {
  readonly observations: readonly StepObservation<I, R>[];
  readonly observationErrors: readonly CaptureFailure[];
}
/** Safe observation at an IO boundary: capture failures never change an executed business outcome. */
export function createObservation<I, R>(capture: WorkflowCapture<I, R>) {
  const observations: StepObservation<I, R>[] = [], errors: CaptureFailure[] = [];
  const observe: StageObserver = (step, value) => {
    let input: I;
    try { input = structuredClone(capture.input(value, step)); }
    catch { errors.push(Object.freeze({ step, phase: 'input', kind: 'CaptureFailed' })); return () => {}; }
    return result => {
      try { observations.push(Object.freeze({ step, input, result: structuredClone(capture.result(result, step)) })); }
      catch { errors.push(Object.freeze({ step, phase: 'result', kind: 'CaptureFailed' })); }
    };
  };
  return { observe, report: (): ObservationReport<I, R> => ({ observations: Object.freeze(observations), observationErrors: Object.freeze(errors) }) };
}
export async function observeEffect<I, O, E>(step: string, input: I, perform: () => Result<O, E> | Promise<Result<O, E>>, observe: StageObserver): Promise<Result<O, E>> {
  const receive = observe(step, input), result = await perform();
  receive(result);
  return result;
}
