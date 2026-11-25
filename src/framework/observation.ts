import { snapshotData } from './snapshot.js';
import type { Result } from './result.js';
import type { WorkflowCapture, StepObservation, StageObserver } from './workflow.js';
/** Capture is synchronous. Contain accidental native async selections without
 * assimilating arbitrary thenables or reading data accessors. Customized and
 * foreign Promise constructors remain outside this synchronous data contract.
 */
export function snapshotCapture<T>(value: T): T {
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Promise.prototype
    && !Object.hasOwn(value, 'constructor')) {
    try {
      // Use both handlers: never propagate a fulfilled object into another
      // promise's resolution procedure, which could read its then property.
      void Promise.prototype.then.call(value, () => undefined, () => undefined);
    } catch { /* A spoofed Promise prototype is still rejected by snapshotData. */ }
  }
  return snapshotData(value);
}
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
    try { input = snapshotCapture(capture.input(value, step)); }
    catch { errors.push(Object.freeze({ step, phase: 'input', kind: 'CaptureFailed' })); return () => {}; }
    return result => {
      try { observations.push(Object.freeze({ step, input, result: snapshotCapture(capture.result(result, step)) })); }
      catch { errors.push(Object.freeze({ step, phase: 'result', kind: 'CaptureFailed' })); }
    };
  };
  return { observe, report: (): ObservationReport<I, R> => ({ observations: Object.freeze(observations), observationErrors: Object.freeze(errors) }) };
}
export async function observeEffect<I, O, E>(step: string, input: I, perform: () => Result<O, E> | Promise<Result<O, E>>, observe: StageObserver): Promise<Result<O, E>> {
  const receive = observe(step, input);
  try { const result = await perform(); receive(result); return result; }
  catch (cause) { try { receive.defect?.(); } catch {} throw cause; }
}
