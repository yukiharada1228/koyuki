import { err, ok, type Result } from './result.js';
import type { ActionReport } from './action.js';
import type { Trace } from './workflow.js';
import { operation, type Operation } from './application.js';

/** The adapter must distinguish a new atomic commit from a concurrent winner's receipt. */
export type Execution<O> =
  | { readonly kind: 'committed'; readonly value: O }
  | { readonly kind: 'replayed'; readonly value: O };
export type Receipt<O> = { readonly kind: 'missing' } | { readonly kind: 'found'; readonly value: O };
export interface ReplayBoundary<I, O, E, RE> {
  readonly lookup: (input: I) => Result<Receipt<O>, RE> | Promise<Result<Receipt<O>, RE>>;
  /** Explicitly classify conflict or unknown-commit failures eligible for receipt resolution. */
  readonly resolveAfter: (error: E) => boolean;
}
export type ReplayInputError = { readonly kind: 'ReplayInputNotCloneable' };

export type ReplayTrace =
  | { readonly kind: 'snapshot'; readonly status: 'ok' | 'error' }
  | { readonly kind: 'lookup'; readonly phase: 'before' | 'after-error'; readonly status: 'found' | 'missing' | 'error' }
  | { readonly kind: 'command'; readonly status: 'committed' | 'replayed' | 'error' }
  | { readonly kind: 'resolution'; readonly status: 'lookup' | 'skip' };
export interface ReplayReport<O, E, RE> {
  readonly result: Result<Execution<O>, E | RE | ReplayInputError>;
  readonly trace: readonly ReplayTrace[];
  /** null means not executed; trace:null means executed without command-level instrumentation. */
  readonly attempt: {
    readonly result: Result<Execution<O>, E>;
    readonly trace: readonly Trace[] | null;
    readonly plan: unknown;
  } | null;
}

// Request ownership must not silently erase validation evidence or invoke accessors.
// This boundary accepts data formats, not arbitrary objects with behavior.
function snapshotRequest<I>(input: I): I {
  const seen = new Set<object>();
  let nullPrototype = false;
  const typed = new Set<object>([Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
    Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype, Uint32Array.prototype,
    Float32Array.prototype, Float64Array.prototype, BigInt64Array.prototype, BigUint64Array.prototype]);
  function inspect(value: unknown): void {
    if (value === null || typeof value === 'undefined' || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') return;
    if (typeof value !== 'object') throw new Error('UnsupportedReplayData');
    if (seen.has(value)) return;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value), array = Array.isArray(value);
    const plain = prototype === Object.prototype || prototype === null, date = prototype === Date.prototype;
    const map = prototype === Map.prototype, set = prototype === Set.prototype;
    const regexp = prototype === RegExp.prototype, buffer = prototype === ArrayBuffer.prototype;
    const view = ArrayBuffer.isView(value) && (prototype === DataView.prototype || typed.has(prototype));
    if (!(plain || array && prototype === Array.prototype || date || map || set || regexp || buffer || view)) throw new Error('UnsupportedReplayData');
    if (prototype === null) nullPrototype = true;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error('UnsupportedReplayData');
      const descriptor = descriptors[key]!;
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('UnsupportedReplayData');
      if (array && key === 'length') continue;
      if (regexp && key === 'lastIndex' && descriptor.value === 0) continue;
      if (!(plain || array || view && prototype !== DataView.prototype && /^(0|[1-9][0-9]*)$/.test(key))) throw new Error('UnsupportedReplayData');
      if (!descriptor.enumerable) throw new Error('UnsupportedReplayData');
      inspect(descriptor.value);
    }
    if (map) for (const [key, item] of Map.prototype.entries.call(value)) { inspect(key); inspect(item); }
    if (set) for (const item of Set.prototype.values.call(value)) inspect(item);
    if (view) {
      // Only an ArrayBuffer provides detached ownership; SharedArrayBuffer does not.
      const source = (value as ArrayBufferView).buffer;
      Reflect.apply(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!, source, []);
      inspect(source);
    }
  }
  inspect(input);
  const request = structuredClone(input);
  const copied = new Set<object>();
  // Native cloning reveals shared buffers even when their original prototype was
  // replaced. Check collection contents and view buffers before any host callback.
  function detached(value: unknown): void {
    if (value === null || typeof value !== 'object' || copied.has(value)) return;
    copied.add(value);
    if (ArrayBuffer.isView(value)) { detached(value.buffer); return; }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      let shared = false;
      if (typeof SharedArrayBuffer !== 'undefined') {
        try { Reflect.apply(Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!, value, []); shared = true; }
        catch { /* Not a shared buffer. */ }
      }
      if (shared) throw new Error('UnsupportedReplayData');
      let entries: IterableIterator<[unknown, unknown]> | undefined;
      try { entries = Map.prototype.entries.call(value); } catch { /* Not a Map. */ }
      if (entries) { for (const [key, item] of entries) { detached(key); detached(item); } return; }
      let values: IterableIterator<unknown> | undefined;
      try { values = Set.prototype.values.call(value); } catch { /* Not a Set. */ }
      if (values) { for (const item of values) detached(item); return; }
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, 'value')) detached(descriptor.value);
    }
  }
  detached(request);
  if (nullPrototype) {
    const restored = new Set<object>();
    function restore(source: unknown, target: unknown): void {
      if (source === null || typeof source !== 'object' || target === null || typeof target !== 'object' || restored.has(source)) return;
      restored.add(source);
      const prototype = Object.getPrototypeOf(source);
      if (prototype === null) Object.setPrototypeOf(target, null);
      if (prototype === Map.prototype) {
        const entries = Map.prototype.entries.call(target);
        for (const [key, value] of Map.prototype.entries.call(source)) {
          const copy = entries.next().value; if (!copy) throw new Error('UnsupportedReplayData');
          restore(key, copy[0]); restore(value, copy[1]);
        }
      } else if (prototype === Set.prototype) {
        const values = Set.prototype.values.call(target);
        for (const value of Set.prototype.values.call(source)) restore(value, values.next().value);
      } else if (ArrayBuffer.isView(source) && ArrayBuffer.isView(target)) restore(source.buffer, target.buffer);
      const copies = Object.getOwnPropertyDescriptors(target);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
        if (Object.hasOwn(descriptor, 'value') && copies[key] && Object.hasOwn(copies[key], 'value')) restore(descriptor.value, copies[key]!.value);
      }
    }
    restore(input, request);
  }
  return request;
}

/** Optional receipt boundary; never retries a command. Unexpected exceptions still reject.
 * run preserves the original run path. runDetailed uses command detail when supplied.
 */
export function withReplay<I, O, E, RE>(command: {
  readonly run: (input: I) => Promise<Result<Execution<O>, E>>;
  readonly runDetailed?: (input: NoInfer<I>) => Promise<ActionReport<Execution<NoInfer<O>>, NoInfer<E>>>;
}, boundary: ReplayBoundary<NoInfer<I>, NoInfer<O>, NoInfer<E>, RE>) {
  const runCommand = command.run.bind(command);
  const detailedCommand = command.runDetailed?.bind(command);
  const lookup = boundary.lookup.bind(boundary), resolveAfter = boundary.resolveAfter.bind(boundary);
  async function execute(input: I, detailed: boolean): Promise<ReplayReport<O, E, RE>> {
    const trace: ReplayTrace[] = [];
    let attempt: ReplayReport<O, E, RE>['attempt'] = null;
    const report = (result: ReplayReport<O, E, RE>['result']): ReplayReport<O, E, RE> => ({ result, trace, attempt });
    let request: I;
    try { request = snapshotRequest(input); }
    catch { trace.push({ kind: 'snapshot', status: 'error' }); return report(err({ kind: 'ReplayInputNotCloneable' })); }
    trace.push({ kind: 'snapshot', status: 'ok' });
    const cached = await lookup(request);
    trace.push({ kind: 'lookup', phase: 'before', status: cached.ok ? cached.value.kind : 'error' });
    if (!cached.ok) return report(cached);
    if (cached.value.kind === 'found') return report(ok({ kind: 'replayed', value: cached.value.value }));
    if (detailed && detailedCommand) attempt = await detailedCommand(request);
    else attempt = { result: await runCommand(request), trace: null, plan: null };
    const result = attempt.result;
    trace.push({ kind: 'command', status: result.ok ? result.value.kind : 'error' });
    if (result.ok) return report(result);
    const resolve = resolveAfter(result.error);
    trace.push({ kind: 'resolution', status: resolve ? 'lookup' : 'skip' });
    if (!resolve) return report(result);
    const raced = await lookup(request);
    trace.push({ kind: 'lookup', phase: 'after-error', status: raced.ok ? raced.value.kind : 'error' });
    if (!raced.ok) return report(raced);
    return report(raced.value.kind === 'found' ? ok({ kind: 'replayed', value: raced.value.value }) : result);
  }
  return {
    run: async (input: I): Promise<Result<Execution<O>, E | RE | ReplayInputError>> => (await execute(input, false)).result,
    runDetailed: (input: I): Promise<ReplayReport<O, E, RE>> => execute(input, true),
  };
}

/** Preserve the current projection on replay. Refreshing stale projections is host-owned. */
export function replayOperation<S, I, O, E>(command: {
  readonly run: (input: I) => Promise<Result<Execution<O>, E>>;
}, reduce: (state: S, output: NoInfer<O>) => S): Operation<S, I, Execution<O>, E> {
  return operation(command, (state, execution) => execution.kind === 'replayed' ? state : reduce(state, execution.value));
}

/** Register commands sharing one projection rule, preserving each input/error pair. */
export function replayOperations<S, const T extends Record<string, {
  run(input: never): Promise<Result<Execution<unknown>, unknown>>;
}>>(commands: T, reduce: (state: S, output: ReplayOutput<T[keyof T]>) => S): {
  [K in keyof T]: Operation<S, ReplayInput<T[K]>, Execution<ReplayOutput<T[K]>>, ReplayError<T[K]>>
} {
  // Each key retains its own command. Only the shared projection rule is widened here.
  const entries = Object.entries(commands).map(([key, command]) => [key,
    replayOperation(command, reduce as (state: S, output: unknown) => S),
  ]);
  return Object.fromEntries(entries) as {
    [K in keyof T]: Operation<S, ReplayInput<T[K]>, Execution<ReplayOutput<T[K]>>, ReplayError<T[K]>>
  };
}
type ReplayInput<T> = T extends { run(input: infer I): unknown } ? I : never;
type ReplayOutput<T> = T extends { run(input: never): Promise<Result<Execution<infer O>, unknown>> } ? O : never;
type ReplayError<T> = T extends { run(input: never): Promise<Result<unknown, infer E>> } ? E : never;
