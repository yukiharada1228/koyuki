/** Experimental authoring API. Mount is synchronous; IO belongs to execute. */
import { defineCommand, defineAction, process, workflow, withReplay, type Result, type Execution, type ReplayBoundary, type ReplayInputError, type ReplayReport } from './index.js';
import { createObservation, type ObservationReport } from './observation.js';
import { Workflow, type Rule, type WorkflowCapture, type StageObserver, type StageReceiver } from './workflow.js';
import { bindDetailed, bindDetailedFunction, invokeDetailed, registerDetailed } from './instrumentation.js';
import { executionSession, type ExecutionOptions, type OperationReport } from './execution.js';
import type { ActionLoad, ActionReport } from './action.js';
import { loadResources, trackPublications, collectPublications, type ResourceTable, type NeedsInput, type NeedsValues, type NeedsError, type Emission, type BusinessEvent, type EventEnvelope, type EventReport, type EventDelivery } from './wiring.js';
import { snapshotData } from './snapshot.js';
export { defineResource, defineEvent, emit } from './wiring.js';
export type { BusinessResource, BusinessEvent, EventEnvelope, EventReport, EventDelivery } from './wiring.js';
const emittedEvents = new WeakMap<object, readonly BusinessEvent<never>[]>();
type Handler<I, O, E> = (input: I) => Promise<Result<O, E>>;
type OperationHandler<I, O, E, D extends OperationReport<O, E>> = {
  readonly run: Handler<I, O, E>;
  readonly runDetailed: (input: I) => Promise<D>;
};
export interface BusinessOperation<I, O, E, D extends OperationReport<O, E> = ActionReport<O, E>> {
  readonly name: string;
  /** Builds a fresh handler synchronously in the current Provider scope; no caching or state. */
  readonly use: () => OperationHandler<I, O, E, D>;
}
type Node = Readonly<{ evaluate: () => void }>;
type Children = Node | readonly Children[] | null;
interface Frame { values: ReadonlyMap<symbol, unknown>; handlers: Map<object, unknown>; names: Set<string>; events: Map<string, BusinessEvent<never>>; routes: Map<object, object[]>; collect?: BusinessEvent<never>[] }
let current: Frame | undefined;
function frame(): Frame {
  if (!current) throw new Error('HooksRequireComponentEvaluation');
  return current;
}
function within<R>(scope: Frame, evaluate: () => R): R {
  const previous = current;
  current = scope;
  try { return evaluate(); } finally { current = previous; }
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
  save: (value: NoInfer<O>, request: NoInfer<I>, events: readonly EventEnvelope[]) => Promise<Result<S, SE>>;
  emits?: readonly Emission<NoInfer<O>>[];
};
function commandFor<I, C, LE, O, DE, S, SE>(definition: Definition<I, C, LE, O, DE, S, SE>) {
  const execute = definition.execute;
  const decide = execute instanceof Workflow ? execute
    : typeof execute === 'function' ? workflow(`${definition.name}:execute`, execute) : undefined;
  const effectful = typeof execute === 'object' && !(execute instanceof Workflow) ? execute : undefined;
  const emissions = definition.emits?.map(item => ({ event: item.event, project: item.project }));
  const forRequest = (request: I, publications: EventEnvelope[], observe?: StageObserver) => {
    const save = async (value: O) => {
      // Project before commit: defects cannot turn a committed result into a retryable failure.
      const events = (emissions ?? []).map(item => Object.freeze({ id: crypto.randomUUID(), type: item.event.name, payload: snapshotData(item.project(value)) }));
      const result = await definition.save(value, request, snapshotData(events));
      const replay = Boolean((definition as { replay?: unknown }).replay);
      if (result.ok && (!replay || (result.value as Execution<unknown>).kind === 'committed')) { publications.push(...events); collectPublications(observe, events); }
      return result;
    };
    return decide
      ? defineCommand({ operation: definition.name, load: definition.load, decide, save })
      : defineAction({ loadName: `${definition.name}:load`, load: definition.load,
        mutation: process<C>().effect(`${definition.name}:execute`, effectful!).effect(definition.name, save) });
  };
  const perform = async (request: I, observe?: StageObserver) => {
    const publications: EventEnvelope[] = [];
    const owned = emissions ? snapshotData(request) : request;
    const report = await invokeDetailed(bindDetailed(forRequest(owned, publications, observe)), owned, observe);
    return emissions ? { ...report, publications: Object.freeze(publications), deliveries: [] as readonly EventDelivery[] } : report;
  };
  const handler = {
    run: async (request: I) => (await perform(request)).result,
    runDetailed: registerDetailed((request: I) => perform(request), perform),
  };
  emittedEvents.set(handler, emissions?.map(item => item.event) ?? []);
  return handler;
}
type RuntimeDefinition = Definition<unknown, unknown, unknown, unknown, unknown, unknown, unknown> & {
  replay?: ReplayBoundary<unknown, unknown, unknown, unknown>;
};
function useDefinition(definition: RuntimeDefinition): unknown {
  frame();
  const command = commandFor(definition);
  // The replay overload requires save to return the atomic commit/replay envelope.
  if (!definition.replay) return command;
  const replayCommand = command as {
    run: Handler<unknown, Execution<unknown>, unknown>;
    runDetailed: (input: unknown) => Promise<ActionReport<Execution<unknown>, unknown>>;
  };
  if (!definition.emits) return withReplay(replayCommand, definition.replay);
  const perform = async (input: unknown, observe?: StageObserver) => {
    let publications: readonly EventEnvelope[] = [];
    const attempt = async (request: unknown, inner?: StageObserver) => {
      const report = await invokeDetailed(bindDetailed(command), request, inner);
      publications = 'publications' in report ? report.publications as readonly EventEnvelope[] : [];
      return report as ActionReport<Execution<unknown>, unknown>;
    };
    const tracked = { run: async (request: unknown) => (await attempt(request)).result,
      runDetailed: registerDetailed((request: unknown) => attempt(request), attempt) };
    const replayed = withReplay(tracked, definition.replay!);
    const report = await invokeDetailed(bindDetailed(replayed), input, observe);
    return { ...report, publications: report.result.ok && report.result.value.kind === 'committed' ? publications : [], deliveries: [] as readonly EventDelivery[] };
  };
  const handler = { run: async (input: unknown) => (await perform(input)).result, runDetailed: registerDetailed((input: unknown) => perform(input), perform) };
  emittedEvents.set(handler, emittedEvents.get(command) ?? []);
  return handler;
}
type Decision<C> = Rule<C, unknown, unknown> | { readonly run: Rule<C, unknown, unknown> } | { readonly runDetailed: (input: C) => Promise<ActionReport<unknown, unknown>> };
type DecisionResult<X> = X extends (...args: never[]) => infer R ? Awaited<R> : X extends { run: (...args: never[]) => infer R } ? Awaited<R> : X extends { runDetailed: (...args: never[]) => infer R } ? Awaited<R> extends { result: infer V } ? V : never : never;
type DecisionSuccess<R> = R extends { ok: true; value: infer O } ? O : never;
type DecisionFailure<R> = R extends { ok: false; error: infer E } ? E : never;
type DecisionOutput<X> = DecisionSuccess<DecisionResult<X>>;
type DecisionError<X> = DecisionFailure<DecisionResult<X>>;
type ConnectedDefinition<N extends ResourceTable, X, S, SE> = {
  readonly needs: N;
  readonly execute: X & NoInfer<Decision<NeedsValues<N>>>;
  readonly emits?: readonly Emission<DecisionOutput<NoInfer<X>>>[];
  readonly useSave: () => (value: DecisionOutput<NoInfer<X>>, input: NeedsInput<NoInfer<N>>, events: readonly EventEnvelope[]) => Promise<Result<S, SE>>;
};
/** A data declaration: resource dependencies and event relations are compiled at mount. */
export function defineOperation<N extends ResourceTable, X, S, SE, RE>(name: string, definition:
  ConnectedDefinition<N, X, Execution<S>, SE> & { readonly useReplay: () => ReplayBoundary<NeedsInput<N>, NoInfer<S>, NeedsError<N> | DecisionError<X> | SE, RE> }
): BusinessOperation<NeedsInput<N>, Execution<S>, NeedsError<N> | DecisionError<X> | SE | RE | ReplayInputError, ReplayReport<S, NeedsError<N> | DecisionError<X> | SE, RE> & EventReport>;
export function defineOperation<N extends ResourceTable, X, S, SE>(name: string, definition:
  ConnectedDefinition<N, X, S, SE> & { readonly useReplay?: never }
): BusinessOperation<NeedsInput<N>, S, NeedsError<N> | DecisionError<X> | SE, ActionReport<S, NeedsError<N> | DecisionError<X> | SE> & EventReport>;
/** Declare an operation once; reuse it for JSX registration and execution. */
export function defineOperation<I, C, LE, O, DE, S, SE, RE>(name: string, useDefinition: () =>
  Omit<Definition<I, C, LE, O, DE, Execution<S>, SE>, 'name'> & { name?: never; needs?: never; emits?: never; replay: ReplayBoundary<NoInfer<I>, NoInfer<S>, LE | DE | SE, RE> }
): BusinessOperation<I, Execution<S>, LE | DE | SE | RE | ReplayInputError, ReplayReport<S, LE | DE | SE, RE>>;
export function defineOperation<I, C, LE, O, DE, S, SE>(name: string, useDefinition: () =>
  Omit<Definition<I, C, LE, O, DE, S, SE>, 'name'> & { name?: never; needs?: never; emits?: never; replay?: never }
): BusinessOperation<I, S, LE | DE | SE, ActionReport<S, LE | DE | SE>>;
export function defineOperation(name: string, factory: (() => object) | { needs: ResourceTable; execute: unknown; useSave: () => Function; emits?: readonly Emission<never>[]; useReplay?: () => object }) {
  return Object.freeze({ name, use() {
    const scope = frame(), collect: BusinessEvent<never>[] = [];
    const handler = within({ ...scope, collect }, () => {
      const definition = typeof factory === 'function' ? factory() : {
        load: loadResources(factory.needs), execute: factory.execute, save: factory.useSave(), emits: factory.emits ?? [],
        ...(factory.useReplay ? { replay: factory.useReplay() } : {}),
      };
      return useDefinition({ ...definition, name } as RuntimeDefinition) as object;
    });
    const events = [...new Set([...(emittedEvents.get(handler) ?? []), ...collect])];
    emittedEvents.set(handler, events); scope.collect?.push(...events);
    return handler;
  } });
}

export function Operation<I, O, E, D extends OperationReport<O, E>>({ operation }: {
  operation: BusinessOperation<I, O, E, D>;
}): Node {
  return { evaluate() {
    const { handlers, names } = frame();
    if (handlers.has(operation) || names.has(operation.name)) throw new Error(`DuplicateOperation:${operation.name}`);
    const handler = operation.use();
    const captured = { run: handler.run.bind(handler), runDetailed: bindDetailedFunction(handler, handler.runDetailed) };
    handlers.set(operation, captured);
    names.add(operation.name);
    const events = emittedEvents.get(handler) ?? [];
    emittedEvents.set(captured, events);
    for (const event of events) registerEvent(event);
  } };
}
function registerEvent(event: BusinessEvent<never>) {
  const events = frame().events;
  if (events.has(event.name) && events.get(event.name) !== event) throw new Error(`DuplicateEvent:${event.name}`);
  events.set(event.name, event);
}
/** Register the consumer in its own Provider scope and connect this event once. */
export function On<T, O, E, D extends OperationReport<O, E>>({ event, operation }: {
  event: BusinessEvent<T>; operation: BusinessOperation<NoInfer<T>, O, E, D>;
}): Node {
  return { evaluate() {
    registerEvent(event as unknown as BusinessEvent<never>);
    Operation({ operation }).evaluate();
    const routes = frame().routes, receivers = routes.get(event) ?? [];
    routes.set(event, [...receivers, operation]);
  } };
}
function validateRoutes(handlers: Map<object, unknown>, events: Map<string, BusinessEvent<never>>, routes: Map<object, object[]>) {
  for (const handler of handlers.values()) for (const event of emittedEvents.get(handler as object) ?? []) {
    if (!event.external && !routes.get(event)?.length) throw new Error(`UnhandledEvent:${event.name}`);
  }
  const visited = new Set<object>(), active = new Set<object>();
  const visit = (event: BusinessEvent<never>) => {
    if (active.has(event)) throw new Error(`EventCycle:${event.name}`);
    if (visited.has(event)) return;
    active.add(event);
    for (const operation of routes.get(event) ?? []) for (const next of emittedEvents.get(handlers.get(operation) as object) ?? []) visit(next);
    active.delete(event); visited.add(event);
  };
  for (const event of events.values()) visit(event);
}
export interface AuthoringOptions extends ExecutionOptions { readonly maxDeliveries?: number }
export function createApplication(root: Node, options?: AuthoringOptions) {
  const handlers = new Map<object, unknown>();
  const maxDeliveries = options?.maxDeliveries ?? 1000;
  if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries <= 0) throw new Error('InvalidDeliveryLimit');
  const events = new Map<string, BusinessEvent<never>>(), routes = new Map<object, object[]>();
  within({ values: new Map(), handlers, names: new Set(), events, routes }, () => visit(root));
  validateRoutes(handlers, events, routes);
  const executions = executionSession(options);
  function entry<I, O, E, D extends OperationReport<O, E>>(operation: BusinessOperation<I, O, E, D>) {
    const handler = handlers.get(operation) as {
      run: Handler<I, O, E>;
      runDetailed: (input: I) => Promise<D>;
    } | undefined;
    if (!handler) throw new Error(`UnregisteredOperation:${operation.name}`);
    return handler;
  }
  async function runOne<I, O, E, D extends OperationReport<O, E>, A, B>(operation: BusinessOperation<I, O, E, D>, input: NoInfer<I>, capture?: WorkflowCapture<A, B>) {
    const handler = entry(operation), context = executions.create(operation.name);
    context?.emit({ kind: 'queued' });
    context?.emit({ kind: 'started' });
    const recorder = capture ? createObservation(capture) : undefined;
    // This entry opts into all explicit instrumented stages, including nested IO.
    // Legacy Workflow/Process capture boundaries retain their existing contract.
    let observe: StageObserver | undefined = recorder ? Object.assign((step: string, value: unknown): StageReceiver => {
      const outer = context?.observe(step, value), selected = recorder.observe(step, value);
      return Object.assign((result: Result<unknown, unknown>) => { selected(result); outer?.(result); },
        { defect: () => { selected.defect?.(); outer?.defect?.(); } });
    }, { live: true as const, scope: context?.observe.scope }) : context?.observe;
    const publications: EventEnvelope[] = [];
    if (!observe && emittedEvents.get(handler)?.length) observe = Object.assign(() => () => {}, { live: true as const });
    if (observe) trackPublications(observe, publications);
    try {
      const detail = await invokeDetailed(handler.runDetailed, input, observe);
      const report = publications.length ? { ...detail, publications: Object.freeze(publications), deliveries: [] as readonly EventDelivery[] } : detail;
      context?.steps(report);
      context?.emit({ kind: 'completed', status: report.result.ok ? 'ok' : 'error' });
      return recorder ? { ...report, ...recorder.report() } : report;
    } catch (cause) {
      context?.emit({ kind: 'completed', status: 'defect' });
      throw cause;
    }
  }
  const deliveryListeners = new Set<(delivery: EventDelivery) => void>();
  function record(deliveries: EventDelivery[], delivery: EventDelivery) {
    const frozen = Object.freeze(delivery); deliveries.push(frozen);
    for (const listener of [...deliveryListeners]) { try { void Promise.resolve(listener(frozen)).catch(() => {}); } catch {} }
  }
  async function route(publications: readonly EventEnvelope[]) {
    const queue = [...publications], deliveries: EventDelivery[] = [];
    let attempts = 0;
    for (let index = 0; index < queue.length; index++) {
      const envelope = queue[index]!, event = events.get(envelope.type);
      if (!event) {
        record(deliveries, { eventId: envelope.id, event: envelope.type, operation: null, status: 'error', error: { kind: 'UnknownEvent' } });
        continue;
      }
      const receivers = routes.get(event) ?? [];
      if (!receivers.length) record(deliveries, { eventId: envelope.id, event: envelope.type, operation: null, status: 'external' });
      for (const operation of receivers) {
        if (++attempts > maxDeliveries) {
          record(deliveries, { eventId: envelope.id, event: envelope.type, operation: null, status: 'limit', error: { kind: 'DeliveryLimitExceeded' } });
          return Object.freeze(deliveries);
        }
        const consumer = operation as BusinessOperation<unknown, unknown, unknown>;
        try {
          const report = await runOne(consumer, snapshotData(envelope.payload));
          record(deliveries, { eventId: envelope.id, event: envelope.type, operation: consumer.name, status: report.result.ok ? 'ok' : 'error', trace: report.trace, ...(!report.result.ok ? { error: report.result.error } : {}) });
          if ('publications' in report) queue.push(...report.publications as readonly EventEnvelope[]);
        } catch (error) {
          record(deliveries, { eventId: envelope.id, event: envelope.type, operation: consumer.name, status: 'defect', error });
        }
      }
    }
    return Object.freeze(deliveries);
  }
  function executeDetailed<I, O, E, D extends OperationReport<O, E>, A, B>(operation: BusinessOperation<I, O, E, D>, input: NoInfer<I>, capture: WorkflowCapture<A, B>): Promise<Omit<D, 'observations' | 'observationErrors'> & ObservationReport<A, B>>;
  function executeDetailed<I, O, E, D extends OperationReport<O, E>>(operation: BusinessOperation<I, O, E, D>, input: NoInfer<I>): Promise<D>;
  async function executeDetailed<I, O, E, D extends OperationReport<O, E>, A, B>(operation: BusinessOperation<I, O, E, D>, input: NoInfer<I>, capture?: WorkflowCapture<A, B>) {
    const report = await runOne(operation, input, capture);
    return 'publications' in report ? { ...report, deliveries: await route(report.publications as readonly EventEnvelope[]) } : report;
  }
  /** Deliver a persisted, host-owned envelope. A decoder is required at this boundary. */
  async function deliver(envelope: EventEnvelope): Promise<Pick<EventReport, 'deliveries'>> {
    const event = events.get(envelope.type);
    if (!event) throw new Error(`UnknownEvent:${envelope.type}`);
    if (!envelope.id.trim()) throw new Error('MissingEventId');
    const decoded = event.decode?.(snapshotData(envelope.payload));
    if (!decoded || !decoded.ok) {
      const deliveries: EventDelivery[] = [];
      record(deliveries, { eventId: envelope.id, event: envelope.type, operation: null, status: 'error', error: decoded && !decoded.ok ? decoded.error : { kind: 'EventDecoderRequired' } });
      return { deliveries: Object.freeze(deliveries) };
    }
    return { deliveries: await route([{ ...envelope, payload: decoded.value }]) };
  }
  function execute<I, O, E, D extends OperationReport<O, E>>(operation: BusinessOperation<I, O, E, D>, input: NoInfer<I>): Promise<Result<O, E>> {
    entry(operation);
    return executeDetailed(operation, input).then(report => report.result);
  }
  return Object.freeze({
    subscribeExecution: executions.subscribe,
    subscribeDelivery(listener: (delivery: EventDelivery) => void) { deliveryListeners.add(listener); return () => { deliveryListeners.delete(listener); }; },
    deliver,
    execute,
    executeDetailed,
  });
}
