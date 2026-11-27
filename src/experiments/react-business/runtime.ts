/** Unpublished authoring experiment. Mount is synchronous; IO belongs to dispatch. */
import { defineCommand, workflow, type Result } from '../../framework/index.js';
import type { ActionReport } from '../../framework/action.js';
type Handler<I, O, E> = (input: I) => Promise<Result<O, E>>;
export interface OperationKey<I, O, E> {
  readonly name: string;
  // Function property makes the input contravariant and preserves the result contract.
  readonly contract?: Handler<I, O, E>;
}
export function operationKey<I, O, E>(name: string): OperationKey<I, O, E> { return Object.freeze({ name }); }
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
export function useOperation<I, C, LE, O, DE, S, SE>(definition: {
  name: string;
  load: (input: I) => Promise<Result<C, LE>>;
  execute: (input: NoInfer<C>) => Result<O, DE>;
  save: (value: NoInfer<O>) => Promise<Result<S, SE>>;
}) {
  frame();
  const command = defineCommand({ operation: definition.name, load: definition.load,
    decide: workflow(`${definition.name}:execute`, definition.execute), save: definition.save });
  return { run: (input: I) => command.run(input), runDetailed: command.runDetailed.bind(command) };
}
export function Operation<I, O, E>({ operation, handler }: {
  operation: OperationKey<I, O, E>;
  handler: { run: Handler<NoInfer<I>, NoInfer<O>, NoInfer<E>>; runDetailed: (input: NoInfer<I>) => Promise<ActionReport<NoInfer<O>, NoInfer<E>>> };
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
    dispatch<I, O, E>(operation: OperationKey<I, O, E>, input: NoInfer<I>): Promise<Result<O, E>> {
      const handler = handlers.get(operation) as { run: Handler<I, O, E> } | undefined;
      if (!handler) throw new Error(`UnregisteredOperation:${operation.name}`);
      return handler.run(input);
    },
    inspect<I, O, E>(operation: OperationKey<I, O, E>, input: NoInfer<I>): Promise<ActionReport<O, E>> {
      const handler = handlers.get(operation) as { runDetailed: (input: I) => Promise<ActionReport<O, E>> } | undefined;
      if (!handler) throw new Error(`UnregisteredOperation:${operation.name}`);
      return handler.runDetailed(input);
    },
  });
}
