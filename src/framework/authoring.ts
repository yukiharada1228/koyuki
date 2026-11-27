/** Experimental authoring API. Mount is synchronous; IO belongs to dispatch. */
import { defineCommand, defineAction, process, workflow, withReplay, type Result, type Execution, type ReplayBoundary, type ReplayInputError, type ReplayReport } from './index.js';
import { createObservation, type ObservationReport } from './observation.js';
import { Workflow, type Rule, type WorkflowCapture, type StageObserver, type StageReceiver } from './workflow.js';
import { bindDetailed, bindDetailedFunction, invokeDetailed, registerDetailed } from './instrumentation.js';
import { executionSession, type ExecutionOptions, type OperationReport } from './execution.js';
import type { ActionLoad, ActionReport } from './action.js';
type Handler<I, O, E> = (input: I) => Promise<Result<O, E>>;
export interface OperationKey<I, O, E, D extends OperationReport<O, E> = ActionReport<O, E>> {
  readonly name: string;
  readonly contract?: { run: Handler<I, O, E>; detail: () => D };
}
/** Infer the complete operation contract from a custom Hook without evaluating it. */
export function operationKey<I, O, E, D extends OperationReport<NoInfer<O>, NoInfer<E>>>(name: string, useHandler: () => {
  readonly run: Handler<I, O, E>;
  readonly runDetailed: (input: NoInfer<I>) => Promise<D>;
}): OperationKey<I, O, E, D>;
export function operationKey<I, O, E>(name: string): OperationKey<I, O, E>;
export function operationKey(name: string, _useHandler?: unknown) { return Object.freeze({ name }); }
export function replayOperationKey<I, O, E, RE>(name: string): OperationKey<I, Execution<O>, E | RE | ReplayInputError, ReplayReport<O, E, RE>> {
  return Object.freeze({ name });
}
type Node = Readonly<{ evaluate: () => void }>;
type Children = Node | readonly Children[] | null;
interface Frame { values: ReadonlyMap<symbol, unknown>; handlers: Map<object, unknown> }
let current: Frame | undefined;
function frame(): Frame {
  if (!current) throw new Error('HooksRequireComponentEvaluation');
  return current;
}
function within(scope: Frame, evaluate: () => void) {
  const previous = current;
  current = scope;
  try { evaluate(); } finally { current = previous; }
}
function visit(children: Children): void {
  if (children === null) return;
  if (Array.isArray(children)) { for (const child of children) visit(child); return; }
  (children as Node).evaluate();
}
export function h<P>(component: (props: P) => Node, props: P, ...children: Children[]): Node {
  // Defer component evaluation until the enclosing Providers have established scope.
  return { evaluate: () => visit(component({ ...props, ...(children.length ? { children } : {}) })) };
}
export namespace h { export namespace JSX {
  export type Element = Node;
  export interface ElementChildrenAttribute { children: unknown }
} }
/** Group sibling operations without introducing another dependency scope. */
export function Fragment({ children }: { children: Children }): Node {
  return { evaluate: () => visit(children) };
}
export function createContext<T>() {
  const id = Symbol('Context');
  return {
    id,
    Provider({ value, children }: { value: T; children: Children }): Node {
      return { evaluate() {
        const parent = frame();
        const values = new Map(parent.values); values.set(id, value);
        within({ ...parent, values }, () => visit(children));
      } };
    },
    // Type-only witness; contexts cannot provide a default actor implicitly.
    type: undefined as T | undefined,
  };
}
export function useContext<T>(context: ReturnType<typeof createContext<T>>): T {
  const values = frame().values;
  if (!values.has(context.id)) throw new Error('MissingContextProvider');
  return values.get(context.id) as T;
}
type Definition<I, C, LE, O, DE, S, SE> = {
  name: string;
  load: ActionLoad<I, C, LE>;
  execute: Rule<NoInfer<C>, O, DE> | (Workflow<C, O, DE> & { readonly run: Rule<NoInfer<C>, O, DE> })
    | { readonly runDetailed: (input: NoInfer<C>) => Promise<ActionReport<O, DE>> };
  save: (value: NoInfer<O>, request: NoInfer<I>) => Promise<Result<S, SE>>;
};
function commandFor<I, C, LE, O, DE, S, SE>(definition: Definition<I, C, LE, O, DE, S, SE>) {
  const execute = definition.execute;
  const decide = execute instanceof Workflow ? execute
    : typeof execute === 'function' ? workflow(`${definition.name}:execute`, execute) : undefined;
  const effectful = typeof execute === 'object' && !(execute instanceof Workflow) ? execute : undefined;
  const forRequest = (request: I) => decide
    ? defineCommand({ operation: definition.name, load: definition.load,
      decide, save: (value: O) => definition.save(value, request) })
    : defineAction({ loadName: `${definition.name}:load`, load: definition.load,
      mutation: process<C>()
        .effect(`${definition.name}:execute`, effectful!)
        .effect(definition.name, (value: O) => definition.save(value, request)),
    });
  return {
    run: (request: I) => forRequest(request).run(request),
    runDetailed: registerDetailed((request: I) => forRequest(request).runDetailed(request),
      (request: I, observe) => invokeDetailed(bindDetailed(forRequest(request)), request, observe)),
  };
}
export function useOperation<I, C, LE, O, DE, S, SE, RE>(definition:
  Definition<I, C, LE, O, DE, Execution<S>, SE> & { replay: ReplayBoundary<NoInfer<I>, NoInfer<S>, LE | DE | SE, RE> }
): {
  run: Handler<I, Execution<S>, LE | DE | SE | RE | ReplayInputError>;
  runDetailed: (input: I) => Promise<ReplayReport<S, LE | DE | SE, RE>>;
};
export function useOperation<I, C, LE, O, DE, S, SE>(definition:
  Definition<I, C, LE, O, DE, S, SE> & { replay?: never }
): {
  run: Handler<I, S, LE | DE | SE>;
  runDetailed: (input: I) => Promise<ActionReport<S, LE | DE | SE>>;
};
export function useOperation(definition: Definition<unknown, unknown, unknown, unknown, unknown, unknown, unknown> & {
  replay?: ReplayBoundary<unknown, unknown, unknown, unknown>;
}): unknown {
  frame();
  const command = commandFor(definition);
  // The replay overload requires save to return the atomic commit/replay envelope.
  return definition.replay ? withReplay(command as {
    run: Handler<unknown, Execution<unknown>, unknown>;
    runDetailed: (input: unknown) => Promise<ActionReport<Execution<unknown>, unknown>>;
  }, definition.replay) : command;
}
export function Operation<I, O, E, D extends OperationReport<O, E>>({ operation, handler }: {
  operation: OperationKey<I, O, E, D>;
  handler: { run: Handler<NoInfer<I>, NoInfer<O>, NoInfer<E>>; runDetailed: (input: NoInfer<I>) => Promise<NoInfer<D>> };
}): Node {
  return { evaluate() {
    const handlers = frame().handlers;
    if (handlers.has(operation)) throw new Error(`DuplicateOperation:${operation.name}`);
    handlers.set(operation, { run: handler.run.bind(handler), runDetailed: bindDetailedFunction(handler, handler.runDetailed) });
  } };
}
export function createApplication(root: Node, options?: ExecutionOptions) {
  const handlers = new Map<object, unknown>();
  within({ values: new Map(), handlers }, () => visit(root));
  const executions = executionSession(options);
  function entry<I, O, E, D extends OperationReport<O, E>>(operation: OperationKey<I, O, E, D>) {
    const handler = handlers.get(operation) as {
      run: Handler<I, O, E>;
      runDetailed: (input: I) => Promise<D>;
    } | undefined;
    if (!handler) throw new Error(`UnregisteredOperation:${operation.name}`);
    return handler;
  }
  function inspect<I, O, E, D extends OperationReport<O, E>, A, B>(operation: OperationKey<I, O, E, D>, input: NoInfer<I>, capture: WorkflowCapture<A, B>): Promise<Omit<D, 'observations' | 'observationErrors'> & ObservationReport<A, B>>;
  function inspect<I, O, E, D extends OperationReport<O, E>>(operation: OperationKey<I, O, E, D>, input: NoInfer<I>): Promise<D>;
  async function inspect<I, O, E, D extends OperationReport<O, E>, A, B>(operation: OperationKey<I, O, E, D>, input: NoInfer<I>, capture?: WorkflowCapture<A, B>) {
    const handler = entry(operation), context = executions.create(operation.name);
    context?.emit({ kind: 'queued' });
    context?.emit({ kind: 'started' });
    const recorder = capture ? createObservation(capture) : undefined;
    // This entry opts into all explicit instrumented stages, including nested IO.
    // Legacy Workflow/Process capture boundaries retain their existing contract.
    const observe: StageObserver | undefined = recorder ? Object.assign((step: string, value: unknown): StageReceiver => {
      const outer = context?.observe(step, value), selected = recorder.observe(step, value);
      return Object.assign((result: Result<unknown, unknown>) => { selected(result); outer?.(result); },
        { defect: () => { selected.defect?.(); outer?.defect?.(); } });
    }, { live: true as const, scope: context?.observe.scope }) : context?.observe;
    try {
      const report = await invokeDetailed(handler.runDetailed, input, observe);
      context?.steps(report);
      context?.emit({ kind: 'completed', status: report.result.ok ? 'ok' : 'error' });
      return recorder ? { ...report, ...recorder.report() } : report;
    } catch (cause) {
      context?.emit({ kind: 'completed', status: 'defect' });
      throw cause;
    }
  }
  return Object.freeze({
    subscribeExecution: executions.subscribe,
    dispatch<I, O, E, D extends OperationReport<O, E>>(operation: OperationKey<I, O, E, D>, input: NoInfer<I>): Promise<Result<O, E>> {
      entry(operation);
      return inspect(operation, input).then(report => report.result);
    },
    inspect,
  });
}
