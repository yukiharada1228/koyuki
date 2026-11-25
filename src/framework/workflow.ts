import type { Result } from './result.js';
import { canonicalIdentity } from './identity.js';
export type Rule<I, O, E> = (input: I) => Result<O, E>;
// A function property keeps input contravariance in emitted declarations, where private
// implementation fields no longer carry the class's input variance.
type WorkflowConsumer<I, O, E> = Workflow<I, O, E> & { readonly run: Rule<I, O, E> };
export interface Trace { readonly step: string; readonly status: 'ok' | 'error' }
export interface Evaluation<O, E> { result: Result<O, E>; trace: readonly Trace[] }
export interface StepObservation<I, R> { readonly step: string; readonly input: I; readonly result: R }
export interface WorkflowCapture<I, R> {
  readonly input: (value: unknown, step: string) => I;
  readonly result: (value: Result<unknown, unknown>, step: string) => R;
}
/** Internal stage hook. The returned receiver retains that stage's selected input. */
export type StageObserver = (step: string, input: unknown) => (result: Result<unknown, unknown>) => void;
export function evaluateRule<I, O, E>(step: string, rule: Rule<I, O, E>, input: I, observe?: StageObserver): Result<O, E> {
  const receive = observe?.(step, input);
  const result = rule(input);
  receive?.(result);
  return result;
}
export class Workflow<I, O, E> {
  constructor(readonly name: string, readonly steps: readonly string[], private readonly evaluate: (input: I, observe?: StageObserver) => Evaluation<O, E>) {}
  readonly run = (input: I): Result<O, E> => this.evaluate(input).result;
  inspect(input: I): Evaluation<O, E>;
  inspect<A, B>(input: I, capture: WorkflowCapture<A, B>): Evaluation<O, E> & { readonly observations: readonly StepObservation<A, B>[] };
  inspect<A, B>(input: I, capture?: WorkflowCapture<A, B>): Evaluation<O, E> & { readonly observations?: readonly StepObservation<A, B>[] } {
    if (!capture) return this.evaluate(input);
    const observations: StepObservation<A, B>[] = [];
    const evaluation = this.evaluate(input, (step, value) => {
      // Select before cloning: unselected fields never enter the recorded snapshot.
      const before = structuredClone(capture.input(value, step));
      return result => observations.push(Object.freeze({ step, input: before, result: structuredClone(capture.result(result, step)) }));
    });
    return { ...evaluation, observations: Object.freeze(observations) };
  }
  branch<N extends O, A, B, F, G>(name: string, predicate: (value: O) => value is N,
    paths: { yes: WorkflowConsumer<N, A, F>; no: WorkflowConsumer<Exclude<O, N>, B, G> }): Workflow<I, A | B, E | F | G>;
  branch<A, B, F, G>(name: string, predicate: (value: O) => boolean,
    paths: { yes: WorkflowConsumer<O, A, F>; no: WorkflowConsumer<O, B, G> }): Workflow<I, A | B, E | F | G>;
  branch<A, B, F, G>(name: string, predicate: (value: O) => boolean,
    paths: { yes: Workflow<never, A, F>; no: Workflow<never, B, G> }): Workflow<I, A | B, E | F | G> {
    return new Workflow<I, A | B, E | F | G>(this.name, [...this.steps, name], (input, observe) => {
      const previous = this.evaluate(input, observe);
      if (!previous.result.ok) return { result: previous.result, trace: previous.trace };
      const selected = predicate(previous.result.value) ? 'yes' : 'no';
      // Public overloads check the branch inputs. Dispatch erases those distinct inputs only
      // after the predicate has selected the path; a user-written type guard is trusted as in TS.
      const next = paths[selected].evaluate(previous.result.value as never, observe);
      return { result: next.result, trace: [...previous.trace, { step: `${name}:${selected}`, status: 'ok' }, ...next.trace] };
    });
  }
  then<N, F>(name: string, rule: Rule<O, N, F>): Workflow<I, N, E | F> {
    return new Workflow<I, N, E | F>(this.name, [...this.steps, name], (input, observe) => {
      const previous = this.evaluate(input, observe);
      if (!previous.result.ok) return { result: previous.result, trace: previous.trace };
      const result = evaluateRule(name, rule, previous.result.value, observe);
      return { result, trace: [...previous.trace, { step: name, status: result.ok ? 'ok' : 'error' }] };
    });
  }
}
export function workflow<I, O, E>(name: string, rule: Rule<I, O, E>): Workflow<I, O, E> {
  return new Workflow(name, [name], (input, observe) => {
    const result = evaluateRule(name, rule, input, observe); return { result, trace: [{ step: name, status: result.ok ? 'ok' : 'error' }] };
  });
}
// This rendering layer describes one mutation, not an implicit pipeline between JSX siblings.
type WriteNode = {
  readonly kind: 'write'; readonly operation: string; readonly input: unknown;
};
const tasks = new WeakMap<WriteNode, { identity: symbol; execute: () => Promise<Result<unknown, unknown>> }>();
export type View = WriteNode | { readonly kind: 'mutation'; readonly name: string; readonly child: View } | { readonly kind: 'done' };
export function ht<P>(component: (props: P) => View, props: P, ...children: View[]): View {
  return component({ ...props, ...(children.length ? { children } : {}) });
}
export namespace ht { export namespace JSX { export type Element = View; export interface ElementChildrenAttribute { children: unknown } } }
export function Mutation({ name, children }: { name: string; children: View | readonly View[] }): View {
  const nodes = Array.isArray(children) ? children : [children as View];
  if (nodes.length !== 1 || !nodes[0]) throw new Error('MutationRequiresOneChild');
  return { kind: 'mutation', name, child: nodes[0] };
}
export const Done = (): View => ({ kind: 'done' });
export function describeView(view: View): unknown {
  if (view.kind === 'mutation') return { kind: view.kind, name: view.name, child: describeView(view.child) };
  if (view.kind === 'done') return { kind: 'done' };
  return { kind: view.kind, operation: view.operation, input: structuredClone(view.input) };
}
// A diagnostic snapshot is not the execution capability or the replay identity.
// Inspect data descriptors first so reporting never invokes domain accessors.
function describeDecision(operation: string, input: unknown): unknown {
  try {
    const active = new Set<object>(), inspected = new Set<object>();
    function inspect(value: unknown): void {
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
      if (typeof value !== 'object' || value === null) throw new Error('OpaquePlanInput');
      if (active.has(value)) throw new Error('OpaquePlanInput');
      if (inspected.has(value)) return;
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('OpaquePlanInput');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length: unknown = array ? descriptors.length?.value : undefined;
      if (array && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)) throw new Error('OpaquePlanInput');
      active.add(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw new Error('OpaquePlanInput');
        if (array && key === 'length') continue;
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('OpaquePlanInput');
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || typeof length !== 'number' || Number(key) >= length)) throw new Error('OpaquePlanInput');
        inspect(descriptor.value);
      }
      if (array && typeof length === 'number' && Object.keys(descriptors).length !== length + 1) throw new Error('OpaquePlanInput');
      active.delete(value); inspected.add(value);
    }
    inspect(input);
    return { kind: 'write', operation, input: structuredClone(input) };
  } catch {
    return { kind: 'write', operation, inputStatus: 'unavailable' };
  }
}
export function bindMutation<I, O, E, S, F>(config: {
  workflow: WorkflowConsumer<I, O, E>;
  operation: string;
  save: (value: NoInfer<O>) => Promise<Result<S, F>>;
  render?: (value: NoInfer<O>) => View;
}) {
  const identity = Symbol(config.operation);
  function Save({ value }: { value: O }): View {
    // Snapshot the visible decision; the domain's opaque immutable value goes to the adapter.
    const node: WriteNode = Object.freeze({ kind: 'write', operation: config.operation, input: structuredClone(value) });
    tasks.set(node, { identity, execute: () => config.save(value) });
    return node;
  }
  function view(value: O): View { return config.render ? config.render(value) : Save({ value }); }
  async function runDetailed(input: I): Promise<{ result: Result<S, E | F>; trace: readonly Trace[]; plan: unknown }> {
    const evaluated = config.workflow.inspect(input), decision = evaluated.result;
    if (!decision.ok) return { result: decision, trace: evaluated.trace, plan: null };
    if (!config.render) {
      // No renderer can substitute a different node. Execute the actual decision,
      // even when it cannot be represented in the diagnostic write plan.
      const plan = describeDecision(config.operation, decision.value);
      const result = await config.save(decision.value);
      return { result, trace: [...evaluated.trace, { step: config.operation, status: result.ok ? 'ok' : 'error' }], plan };
    }
    const rendered = view(decision.value);
    let node = rendered;
    while (node.kind === 'mutation') node = node.child;
    if (node.kind !== 'write') throw new Error('WrongMutationBinding');
    const task = tasks.get(node);
    if (!task || task.identity !== identity) throw new Error('WrongMutationBinding');
    if (canonicalIdentity(node.input) !== canonicalIdentity(decision.value)) throw new Error('ChangedDecision');
    const result = await task.execute() as Result<S, F>;
    return { result, trace: [...evaluated.trace, { step: config.operation, status: result.ok ? 'ok' : 'error' }], plan: describeView(rendered) };
  }
  async function run(input: I): Promise<Result<S, E | F>> { return (await runDetailed(input)).result; }
  return { Save, view, run, runDetailed, prepare: (input: I) => config.workflow.inspect(input), steps: config.workflow.steps };
}
