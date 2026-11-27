/** Unpublished authoring experiment. Mount is synchronous; IO belongs to dispatch. */
import { defineCommand, workflow, withReplay, type Result, type Execution, type ReplayBoundary, type ReplayInputError, type ReplayReport } from '../../framework/index.js';
import { Workflow, type Rule } from '../../framework/workflow.js';
import type { ActionReport } from '../../framework/action.js';
type Handler<I, O, E> = (input: I) => Promise<Result<O, E>>;
export interface OperationKey<I, O, E, D = ActionReport<O, E>> {
  readonly name: string;
  readonly contract?: { run: Handler<I, O, E>; detail: () => D };
}
export function operationKey<I, O, E>(name: string): OperationKey<I, O, E> { return Object.freeze({ name }); }
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
  load: (input: I) => Promise<Result<C, LE>>;
  execute: Rule<NoInfer<C>, O, DE> | (Workflow<C, O, DE> & { readonly run: Rule<NoInfer<C>, O, DE> });
  save: (value: NoInfer<O>, request: NoInfer<I>) => Promise<Result<S, SE>>;
};
function commandFor<I, C, LE, O, DE, S, SE>(definition: Definition<I, C, LE, O, DE, S, SE>) {
  const decide = definition.execute instanceof Workflow ? definition.execute
    : workflow(`${definition.name}:execute`, definition.execute);
  const forRequest = (request: I) => defineCommand({ operation: definition.name, load: definition.load,
    decide, save: (value: O) => definition.save(value, request) });
  return {
    run: (request: I) => forRequest(request).run(request),
    runDetailed: (request: I) => forRequest(request).runDetailed(request),
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
export function Operation<I, O, E, D>({ operation, handler }: {
  operation: OperationKey<I, O, E, D>;
  handler: { run: Handler<NoInfer<I>, NoInfer<O>, NoInfer<E>>; runDetailed: (input: NoInfer<I>) => Promise<NoInfer<D>> };
}): Node {
  return { evaluate() {
    const handlers = frame().handlers;
    if (handlers.has(operation)) throw new Error(`DuplicateOperation:${operation.name}`);
    handlers.set(operation, handler);
  } };
}
export function createApplication(root: Node) {
  const handlers = new Map<object, unknown>();
  within({ values: new Map(), handlers }, () => visit(root));
  return Object.freeze({
    dispatch<I, O, E, D>(operation: OperationKey<I, O, E, D>, input: NoInfer<I>): Promise<Result<O, E>> {
      const handler = handlers.get(operation) as { run: Handler<I, O, E> } | undefined;
      if (!handler) throw new Error(`UnregisteredOperation:${operation.name}`);
      return handler.run(input);
    },
    inspect<I, O, E, D>(operation: OperationKey<I, O, E, D>, input: NoInfer<I>): Promise<D> {
      const handler = handlers.get(operation) as { runDetailed: (input: I) => Promise<D> } | undefined;
      if (!handler) throw new Error(`UnregisteredOperation:${operation.name}`);
      return handler.runDetailed(input);
    },
  });
}
