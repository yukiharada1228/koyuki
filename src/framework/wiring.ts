import { ok, type Result } from './result.js';
import type { ActionReport } from './action.js';
import type { StageObserver } from './workflow.js';
import { registerDetailed } from './instrumentation.js';
import { observeEffect } from './observation.js';
/** A declaration evaluated in its operation's Provider scope, never on a request. */
export interface BusinessResource<I, V, E> {
  readonly name: string;
  readonly use: () => (input: I) => Result<V, E> | Promise<Result<V, E>>;
}
type ResourceSuccess<R> = R extends { ok: true; value: infer V } ? V : never;
type ResourceFailure<R> = R extends { ok: false; error: infer E } ? E : never;
type ResourceCallInput<F> = [F] extends [(input: infer I) => unknown] ? I : never;
export type ResourceTable = Readonly<Record<string, BusinessResource<never, unknown, unknown>>>;
export type ResourceSpec = ResourceTable | BusinessResource<never, unknown, unknown>;
type RequiredCall<R> = R extends BusinessResource<infer I, unknown, unknown> ? unknown extends I ? never : (input: I) => void : never;
type RequiredCalls<N extends ResourceTable> = { [K in keyof N]: RequiredCall<N[K]> }[keyof N];
// Preserve unions accepted by one resource, intersect requirements of selections.
type TableInput<N extends ResourceTable> = [RequiredCalls<N>] extends [never] ? unknown
  : [RequiredCalls<N>] extends [(input: infer I) => void] ? I : never;
export type NeedsInput<N extends ResourceSpec> = [N] extends [BusinessResource<never, unknown, unknown>]
  ? [RequiredCall<N>] extends [never] ? unknown : [RequiredCall<N>] extends [(input: infer I) => void] ? I : never
  : TableInput<Extract<N, ResourceTable>>;
export type NeedsValues<N extends ResourceSpec> = N extends BusinessResource<never, infer V, unknown> ? V : { readonly [K in keyof N]: N[K] extends BusinessResource<never, infer V, unknown> ? V : never };
export type NeedsError<N extends ResourceSpec> = N extends BusinessResource<never, unknown, infer E> ? E : N[keyof N] extends BusinessResource<never, unknown, infer E> ? E : never;
type ResourceLoader = (input: never) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>;
type ResourceDeclaration = { readonly needs: ResourceTable; readonly useLoad: () => ResourceLoader };
const dependencies = new WeakMap<object, ResourceDeclaration>();
export function defineResource<N extends ResourceTable, F extends ResourceLoader>(name: string, declaration: {
  readonly needs: N;
  readonly useLoad: () => F & NoInfer<(context: NeedsValues<N>) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>>;
}): BusinessResource<NeedsInput<N>, ResourceSuccess<Awaited<ReturnType<F>>>, NeedsError<N> | ResourceFailure<Awaited<ReturnType<F>>>>;
export function defineResource<F extends ResourceLoader>(name: string, factory: () => F): BusinessResource<ResourceCallInput<F>, ResourceSuccess<Awaited<ReturnType<F>>>, ResourceFailure<Awaited<ReturnType<F>>>>;
export function defineResource(name: string, declaration: (() => ResourceLoader) | ResourceDeclaration) {
  if (!name.trim()) throw new Error('EmptyResourceName');
  const resource: { readonly name: string; readonly use: () => ResourceLoader } = Object.freeze({ name, use(): ResourceLoader {
    if (typeof declaration === 'function') return declaration();
    const load = loadResources({ value: resource as unknown as BusinessResource<never, unknown, unknown> });
    return async (input: unknown) => {
      const report = await load.runDetailed(input as never);
      return report.result.ok ? ok(report.result.value.value) : report.result;
    };
  } });
  if (typeof declaration !== 'function') dependencies.set(resource, declaration);
  return resource;
}
function entries(needs: ResourceTable) {
  if (!needs || ![Object.prototype, null].includes(Object.getPrototypeOf(needs))) throw new TypeError('NeedsRequirePlainRecord');
  if (Object.getOwnPropertySymbols(needs).length) throw new TypeError('NeedsRequireStringKeys');
  return Object.getOwnPropertyNames(needs).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(needs, key)!;
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('NeedsRequireDataFields');
    return [key, descriptor.value as BusinessResource<never, unknown, unknown>] as const;
  });
}
export function loadResources<N extends ResourceSpec>(needs: N): { readonly runDetailed: (input: NeedsInput<N>) => Promise<ActionReport<NeedsValues<N>, NeedsError<N>>> } {
  type Resource = BusinessResource<never, unknown, unknown>;
  interface Node { resource: Resource; fields: readonly (readonly [string, Resource])[] | undefined; load: ResourceLoader }
  const nodes = new Map<object, Node>(), names = new Map<string, object>(), active = new Set<object>();
  const bind = (resource: Resource): void => {
    if (active.has(resource)) throw new Error(`ResourceCycle:${resource.name}`);
    if (nodes.has(resource)) return;
    if (names.has(resource.name) && names.get(resource.name) !== resource) throw new Error(`DuplicateResource:${resource.name}`);
    names.set(resource.name, resource); active.add(resource);
    const declaration = dependencies.get(resource);
    const fields = declaration ? entries(declaration.needs) : undefined;
    for (const [, child] of fields ?? []) bind(child);
    const load = declaration ? declaration.useLoad() : resource.use();
    nodes.set(resource, { resource, fields, load }); active.delete(resource);
  };
  const direct = typeof Object.getOwnPropertyDescriptor(needs, 'use')?.value === 'function';
  const fields = direct ? [['value', needs as BusinessResource<never, unknown, unknown>] as const] : entries(needs as ResourceTable);
  for (const [, resource] of fields) bind(resource);
  const perform = async (input: NeedsInput<N>, observe?: StageObserver): Promise<ActionReport<NeedsValues<N>, NeedsError<N>>> => {
    const cache = new Map<object, Promise<Result<unknown, unknown>>>(), trace: { step: string; status: 'ok' | 'error' }[] = [];
    const context = async (fields: readonly (readonly [string, Resource])[]): Promise<Result<Readonly<Record<string, unknown>>, unknown>> => {
      const values: Record<string, unknown> = {};
      for (const [key, resource] of fields) {
        const value = await resolve(resource);
        if (!value.ok) return value;
        Object.defineProperty(values, key, { value: value.value, enumerable: true });
      }
      return ok(Object.freeze(values));
    };
    const resolve = (resource: Resource): Promise<Result<unknown, unknown>> => {
      const cached = cache.get(resource); if (cached) return cached;
      const node = nodes.get(resource)!;
      const promise = (async () => {
        let value: unknown = input;
        if (node.fields) {
          const loaded = await context(node.fields); if (!loaded.ok) return loaded;
          value = loaded.value;
        }
        const step = `resource:${resource.name}`, call = () => node.load(value as never);
        const result = observe ? await observeEffect(step, value, call, observe) : await call();
        trace.push({ step, status: result.ok ? 'ok' : 'error' });
        return result;
      })();
      cache.set(resource, promise); return promise;
    };
    const result = await context(fields);
    // Field/value and error correspondence is checked at the public declarations.
    return { result: (direct && result.ok ? ok(result.value.value) : result) as Result<NeedsValues<N>, NeedsError<N>>, trace, plan: null };
  };
  return { runDetailed: registerDetailed((input: NeedsInput<N>) => perform(input), perform) };
}
const payloadType: unique symbol = Symbol('EventPayload');
/** Identity is explicit; equal payload types do not imply an event connection. */
export interface BusinessEvent<T> {
  readonly name: string;
  readonly external: boolean;
  readonly decode?: (input: unknown) => Result<T, unknown>;
  readonly [payloadType]: (value: T) => T;
}
export function defineEvent<T>(name: string, options: { readonly external?: boolean; readonly decode?: (input: unknown) => Result<T, unknown> } = {}): BusinessEvent<T> {
  if (!name.trim()) throw new Error('EmptyEventName');
  return Object.freeze({ name, external: options.external ?? false, decode: options.decode, [payloadType]: (value: T) => value });
}
export interface EventEnvelope<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly payload: T;
}
export interface Emission<O> {
  readonly event: BusinessEvent<never>;
  readonly project: (value: O) => unknown;
}
export function emit<T>(event: BusinessEvent<T>): Emission<T>;
export function emit<T, O>(event: BusinessEvent<T>, project: (value: O) => NoInfer<T>): Emission<O>;
export function emit<T, O>(event: BusinessEvent<T>, project?: (value: O) => T): Emission<O> {
  return Object.freeze({ event: event as unknown as BusinessEvent<never>, project: project ?? ((value: O) => value) });
}
export interface EventDelivery {
  readonly eventId: string;
  readonly event: string;
  readonly operation: string | null;
  readonly status: 'ok' | 'error' | 'defect' | 'external' | 'limit';
  readonly trace?: readonly unknown[];
  readonly error?: unknown;
}
export interface EventReport {
  readonly publications: readonly EventEnvelope[];
  readonly deliveries: readonly EventDelivery[];
}

// Request-local publication propagation follows the same explicit instrumentation
// capability as detailed Process composition; no global async request context.
const publicationScopes = new WeakMap<StageObserver, EventEnvelope[]>();
export function trackPublications(observe: StageObserver, events: EventEnvelope[]) { publicationScopes.set(observe, events); }
export function collectPublications(observe: StageObserver | undefined, events: readonly EventEnvelope[]) {
  if (observe) publicationScopes.get(observe)?.push(...events);
}
