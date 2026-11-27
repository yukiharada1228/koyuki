import { defineProgram, next, effect } from './program.js';
import { ok, err, type Result } from './result.js';
import { snapshotData } from './snapshot.js';
import { operationEntries } from './operation-table.js';
import type { ApplicationState, Operation as ApplicationOperation, ApplicationEvent, UnexpectedException } from './application.js';
import type { BusinessOperation, BusinessQuery } from './authoring.js';
import type { OperationReport } from './execution.js';
import type { EventReport, EventEnvelope } from './wiring.js';
export function projection<I, O, E, D extends OperationReport<O, E>>(operation: BusinessOperation<I, O, E, D>): {
  readonly operation: BusinessOperation<I, O, E, D>; readonly reduce: <S>(state: S) => S;
};
export function projection<S, I, O, E, D extends OperationReport<O, E>>(operation: BusinessOperation<I, O, E, D>, reduce: (state: S, output: NoInfer<O>) => S): {
  readonly operation: BusinessOperation<I, O, E, D>; readonly reduce: (state: S, output: O) => S;
};
export function projection(operation: BusinessOperation<never, unknown, unknown, OperationReport<unknown, unknown>>, reduce: Function = <S>(state: S) => state) { return Object.freeze({ operation, reduce }); }
export type EventTrigger = Readonly<{ name: string; external: boolean }>;
/** Query input and selection are scoped to this view; domain functions know no view. */
export function refreshQuery<S, I, O, E>(query: BusinessQuery<I, O, E>, config: {
  input: (state: S) => NoInfer<I>;
  on: readonly EventTrigger[];
  reduce: (state: S, value: NoInfer<O>) => S;
}) { return Object.freeze({ query, ...config }); }
export type ProjectionTable<S> = Record<string, {
  readonly operation: BusinessOperation<never, unknown, unknown, OperationReport<unknown, unknown>>;
  readonly reduce: (state: S, output: never) => S;
}>;
export type RefreshTable<S> = Record<string, {
  readonly query: BusinessQuery<never, unknown, unknown>;
  readonly input: (state: S) => unknown;
  readonly on: readonly EventTrigger[];
  readonly reduce: (state: S, output: never) => S;
}>;
export type BoundProjections<S, T extends ProjectionTable<S>> = {
  [K in keyof T]: T[K]['operation'] extends BusinessOperation<infer I, infer O, infer E, OperationReport<infer O, infer E>> ? ApplicationOperation<S, I, O, E> : never
};
export type CheckedProjections<S, T extends ProjectionTable<S>> = {
  [K in keyof T]: T[K]['operation'] extends BusinessOperation<infer I, infer O, infer E, OperationReport<infer O, infer E>>
    ? T[K]['reduce'] extends (state: S, output: O) => S ? unknown : never : never
};
export type CheckedQueries<S, Q extends RefreshTable<S>> = {
  [K in keyof Q]: Q[K]['query'] extends BusinessQuery<infer I, infer O, infer E>
    ? Q[K]['input'] extends (state: S) => I ? Q[K]['reduce'] extends (state: S, output: O) => S ? unknown : never : never : never
};
export type QueryStatus<E> = { readonly kind: 'idle' | 'running' | 'ready' } | { readonly kind: 'failed'; readonly error: E } | { readonly kind: 'crashed'; readonly error: UnexpectedException };
export type ViewState<S, T extends ProjectionTable<S>, Q extends RefreshTable<S>> = ApplicationState<S, BoundProjections<S, T>> & {
  readonly refreshing: boolean;
  readonly queries: { readonly [K in keyof Q]: QueryStatus<Q[K]['query'] extends BusinessQuery<never, unknown, infer E> ? E : never> };
};
export type ViewDefinition<S, T extends ProjectionTable<S>, Q extends RefreshTable<S>, V> = {
  initial: () => S;
  operations: T & NoInfer<CheckedProjections<S, T>>;
  queries?: Q & NoInfer<CheckedQueries<S, Q>>;
  view: (state: ViewState<S, T, Q>) => V;
};
export function defineView<S, const T extends ProjectionTable<S>, V, const Q extends RefreshTable<S> = {}>(definition: ViewDefinition<S, T, Q, V>) { return definition; }
export interface ViewExecutor {
  deliver(envelope: EventEnvelope): Promise<{ invalidates: readonly string[] }>;
  ensure(operation: BusinessOperation<never, unknown, unknown, OperationReport<unknown, unknown>>): void;
  eventKnown(event: EventTrigger): boolean;
  invalidates(operation: BusinessOperation<never, unknown, unknown, OperationReport<unknown, unknown>>, report?: OperationReport<unknown, unknown> & Partial<EventReport>): readonly string[];
  execute(operation: BusinessOperation<never, unknown, unknown, OperationReport<unknown, unknown>>, input: unknown): Promise<OperationReport<unknown, unknown> & Partial<EventReport>>;
}
function defect(cause: unknown): UnexpectedException {
  try { return { kind: 'UnexpectedException', message: cause instanceof Error ? String(cause.message) : typeof cause === 'string' ? cause : 'Unexpected exception' }; }
  catch { return { kind: 'UnexpectedException', message: 'Unexpected exception' }; }
}
function setQueryStatus(record: Record<string, QueryStatus<unknown>>, name: string, value: QueryStatus<unknown>) {
  Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
}
/** Reuse the owned, serialized Program loop for operation completion AND query updates. */
export async function startView<S, const T extends ProjectionTable<S>, V, const Q extends RefreshTable<S> = {}>(definition: ViewDefinition<S, T, Q, V>, executor: ViewExecutor) {
  type State = ViewState<S, T, Q>;
  const operations = new Map(operationEntries(definition.operations)), queries = new Map(operationEntries(definition.queries ?? {} as Q));
  const selected = new Set<object>();
  for (const [name, binding] of operations) {
    if (name === 'dismiss' || name.startsWith('@')) throw new Error('ReservedOperationName');
    executor.ensure(binding.operation);
    if (selected.has(binding.operation)) throw new Error(`DuplicateProjection:${binding.operation.name}`);
    selected.add(binding.operation);
  }
  for (const [, binding] of queries) {
    executor.ensure(binding.query);
    for (const event of binding.on) if (!executor.eventKnown(event)) throw new Error(`UnknownRefreshEvent:${event.name}`);
  }
  // Capture callable configuration before async work, just as mounted operations do.
  const rootBindings = new Map([...operations].map(([key, value]) => [key, { operation: value.operation, reduce: value.reduce }]));
  const queryBindings = new Map([...queries].map(([key, value]) => [key, { query: value.query, input: value.input, reduce: value.reduce, on: new Set(value.on.map(event => event.name)) }]));
  type QueryResult = { name: string; result: Result<unknown, unknown> } | { name: string; defect: UnexpectedException };
  type Message = { type: '@execute'; name: string; input: unknown } | { type: '@completed'; name: string; report: OperationReport<unknown, unknown> & Partial<EventReport> }
    | { type: '@crashed'; name: string; error: UnexpectedException; invalidates: readonly string[] } | { type: '@queries'; values: readonly QueryResult[] } | { type: '@refresh' } | { type: '@deliver'; envelope: EventEnvelope } | { type: '@delivered'; invalidates: readonly string[] } | { type: 'dismiss' };
  function refresh(data: S, names: readonly string[]) {
    return effect('view.refresh', async (): Promise<readonly QueryResult[]> => {
      const values: QueryResult[] = [];
      for (const name of names) {
        const binding = queryBindings.get(name)!;
        try {
          const input = binding.input(snapshotData(data));
          const report = await executor.execute(binding.query, snapshotData(input));
          values.push({ name, result: snapshotData(report.result) });
        } catch (cause) { values.push({ name, defect: defect(cause) }); }
      }
      return values;
    }, (values): Message => ({ type: '@queries', values }))(undefined);
  }
  function withRefresh(state: State, names: readonly string[]) {
    const statuses = { ...state.queries } as Record<string, QueryStatus<unknown>>;
    for (const name of names) setQueryStatus(statuses, name, { kind: 'running' });
    return next<State, Message>({ ...state, queries: statuses, refreshing: names.length > 0 } as State, ...(names.length ? [refresh(state.data, names)] : []));
  }
  const program = defineProgram<State, Message, { kind: 'UnexpectedMessage' }, V>({
    init() {
      const state = { kind: 'ready', data: definition.initial(), queries: {}, refreshing: false } as State;
      return withRefresh(state, [...queryBindings.keys()]);
    },
    update(state, message) {
      if (message.type === '@deliver') {
        const command = effect('view.deliver', () => executor.deliver(message.envelope), (report): Message => ({ type: '@delivered', invalidates: report.invalidates }))(undefined);
        return ok(next<State, Message>(state, command));
      }
      if (message.type === '@delivered') {
        const names = [...queryBindings].filter(([, binding]) => [...binding.on].some(name => message.invalidates.includes(name))).map(([name]) => name);
        return ok(withRefresh(state, names));
      }
      if (message.type === '@refresh') return ok(withRefresh(state, [...queryBindings.keys()]));
      if (message.type === '@queries') {
        let data = state.data;
        const statuses = { ...state.queries } as Record<string, QueryStatus<unknown>>;
        for (const item of message.values) {
          if ('defect' in item) { setQueryStatus(statuses, item.name, { kind: 'crashed', error: item.defect }); continue; }
          if (!item.result.ok) { setQueryStatus(statuses, item.name, { kind: 'failed', error: item.result.error }); continue; }
          try {
            const reduce = queryBindings.get(item.name)!.reduce as (state: S, value: unknown) => S;
            data = snapshotData(reduce(snapshotData(data), item.result.value));
            setQueryStatus(statuses, item.name, { kind: 'ready' });
          } catch (cause) { setQueryStatus(statuses, item.name, { kind: 'crashed', error: defect(cause) }); }
        }
        return ok(next<State, Message>({ ...state, data, queries: statuses, refreshing: false } as State));
      }
      if (message.type === 'dismiss' && (state.kind === 'failed' || state.kind === 'crashed')) return ok(next<State, Message>({ kind: 'ready', data: state.data, queries: state.queries, refreshing: false } as State));
      if (message.type === '@execute' && state.kind === 'ready') {
        const binding = rootBindings.get(message.name); if (!binding) return err({ kind: 'UnexpectedMessage' });
        const command = effect(binding.operation.name, async (): Promise<Message> => {
          try { return { type: '@completed', name: message.name, report: await executor.execute(binding.operation, message.input) }; }
          catch (cause) { return { type: '@crashed', name: message.name, error: defect(cause), invalidates: executor.invalidates(binding.operation) }; }
        }, value => value)(undefined);
        return ok(next<State, Message>({ ...state, kind: 'running', operation: message.name } as State, command));
      }
      if (state.kind === 'running' && message.type === '@crashed' && state.operation === message.name) {
        const names = [...queryBindings].filter(([, binding]) => [...binding.on].some(name => message.invalidates.includes(name))).map(([name]) => name);
        return ok(withRefresh({ ...state, kind: 'crashed', error: message.error } as State, names));
      }
      if (state.kind === 'running' && message.type === '@completed' && state.operation === message.name) {
        const result = message.report.result;
        let completed: State;
        try {
          if (result.ok) {
            const reduce = rootBindings.get(message.name)!.reduce as (state: S, value: unknown) => S;
            completed = { kind: 'ready', data: snapshotData(reduce(snapshotData(state.data), snapshotData(result.value))), queries: state.queries, refreshing: false } as State;
          } else completed = { ...state, kind: 'failed', error: snapshotData(result.error) } as State;
        } catch (cause) { completed = { ...state, kind: 'crashed', error: defect(cause) } as State; }
        const emitted = new Set(executor.invalidates(rootBindings.get(message.name)!.operation, message.report));
        const names = [...queryBindings].filter(([, binding]) => [...binding.on].some(name => emitted.has(name))).map(([name]) => name);
        return ok(withRefresh(completed, names));
      }
      return err({ kind: 'UnexpectedMessage' });
    },
    view: definition.view,
  });
  const session = await program.start();
  return Object.freeze({
    snapshot: session.snapshot, subscribe: session.subscribe, trace: session.trace,
    deliver(envelope: EventEnvelope, expectedRevision?: number) {
      try { return session.dispatch({ type: '@deliver', envelope: snapshotData(envelope) }, expectedRevision); }
      catch (cause) { return Promise.reject(cause); }
    },
    refresh: (expectedRevision?: number) => session.dispatch({ type: '@refresh' }, expectedRevision),
    dispatch(event: ApplicationEvent<BoundProjections<S, T>>, expectedRevision?: number) {
      let request: typeof event;
      try { request = snapshotData(event); } catch (cause) { return Promise.reject(cause); }
      if (request.type === 'dismiss') return session.dispatch({ type: 'dismiss' }, expectedRevision);
      if (!rootBindings.has(request.type)) return Promise.resolve(err({ kind: 'UnexpectedMessage' as const }));
      return session.dispatch({ type: '@execute', name: request.type, input: (request as { input: unknown }).input }, expectedRevision);
    },
  });
}
