import { ok, err, type Result } from './result.js';
import type { Rule } from './workflow.js';
import { isPlainRecord } from './snapshot.js';
type Value<R> = R extends { ok: true; value: infer A } ? A : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type FieldName<K> = K extends string ? K : K extends number ? number extends K ? string : `${K}` : never;
/** Combine already-evaluated results positionally; return the first failure unchanged.
 * This stops inspecting later results, not the computations that produced them.
 */
export function combine<const T extends readonly Result<unknown, unknown>[]>(results: T): Result<
  { readonly [K in keyof T]: Value<T[K]> }, Failure<T[number]>
> {
  const values: unknown[] = [];
  for (const result of results) {
    if (!result.ok) return result as { ok: false; error: Failure<T[number]> };
    values.push(result.value);
  }
  // Iteration erases tuple positions; values were copied in exactly that order.
  return ok(Object.freeze(values)) as Result<{ readonly [K in keyof T]: Value<T[K]> }, Failure<T[number]>>;
}

/** Combine independent, already-evaluated validations. Never short-circuits. */
export function collect<const T extends Record<string, Result<unknown, unknown>>>(fields: T): Result<
  { readonly [K in keyof T]: Value<T[K]> },
  readonly { readonly [K in keyof T]: { readonly field: FieldName<K>; readonly error: Failure<T[K]> } }[keyof T][]
> {
  if (!isPlainRecord(fields)) throw new TypeError('CollectRequiresPlainRecord');
  const descriptors = Object.getOwnPropertyDescriptors(fields);
  const entries: [string, Result<unknown, unknown>][] = [];
  // Validate the whole table before inspecting Results. Never omit typed fields
  // or evaluate a getter while collecting independent validation outcomes.
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor;
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) throw new TypeError('CollectRequiresStringDataKeys');
    entries.push([key, descriptor.value]);
  }
  const values: Record<string, unknown> = {};
  const failures: { field: string; error: unknown }[] = [];
  for (const [field, result] of entries) {
    if (result.ok) Object.defineProperty(values, field, { value: result.value, enumerable: true });
    else failures.push(Object.freeze({ field, error: result.error }));
  }
  // Descriptor iteration loses the relationship between each key and its Result type.
  return (failures.length ? err(Object.freeze(failures)) : ok(Object.freeze(values))) as Result<
    { readonly [K in keyof T]: Value<T[K]> },
    readonly { readonly [K in keyof T]: { readonly field: FieldName<K>; readonly error: Failure<T[K]> } }[keyof T][]
  >;
}

/** Validate independent elements in input order, retaining every failure's zero-based index.
 * This is a synchronous Rule, not a concurrent effect runner. Throws still escape.
 */
export function collectEach<I, O, E>(rule: Rule<I, O, E>): Rule<readonly I[], readonly O[], readonly { readonly index: number; readonly error: E }[]> {
  return input => {
    // Own the collection's positions without freezing or cloning caller-owned element values.
    const items = [...input];
    const values: O[] = [];
    const failures: { readonly index: number; readonly error: E }[] = [];
    for (const [index, item] of items.entries()) {
      const result = rule(item);
      if (result.ok) values.push(result.value);
      else failures.push(Object.freeze({ index, error: result.error }));
    }
    return failures.length ? err(Object.freeze(failures)) : ok(Object.freeze(values));
  };
}

/** Fold dependent synchronous calculations in order; preserve the first failure unchanged.
 * The initializer runs once per invocation. State purity/ownership remains caller-owned.
 */
export function foldEach<I, S, E>(initial: () => S, reduce: (state: NoInfer<S>, item: I, index: number) => Result<S, E>): Rule<readonly I[], S, E> {
  return input => {
    const items = [...input];
    let state = initial();
    for (const [index, item] of items.entries()) {
      const result = reduce(state, item, index);
      if (!result.ok) return result;
      state = result.value;
    }
    return ok(state);
  };
}
