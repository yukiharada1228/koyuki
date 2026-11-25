import { ok, err, type Result } from './result.js';
import type { Rule } from './workflow.js';
type Value<R> = R extends { ok: true; value: infer A } ? A : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
/** Combine independent, already-evaluated validations. Never short-circuits. */
export function collect<const T extends Record<string, Result<unknown, unknown>>>(fields: T): Result<
  { readonly [K in keyof T]: Value<T[K]> },
  readonly { readonly [K in keyof T]: { readonly field: K; readonly error: Failure<T[K]> } }[keyof T][]
> {
  const values: Record<string, unknown> = {};
  const failures: { field: string; error: unknown }[] = [];
  for (const [field, result] of Object.entries(fields)) {
    if (result.ok) Object.defineProperty(values, field, { value: result.value, enumerable: true });
    else failures.push(Object.freeze({ field, error: result.error }));
  }
  // Object.entries loses the relationship between each key and its Result type.
  return (failures.length ? err(Object.freeze(failures)) : ok(Object.freeze(values))) as Result<
    { readonly [K in keyof T]: Value<T[K]> },
    readonly { readonly [K in keyof T]: { readonly field: K; readonly error: Failure<T[K]> } }[keyof T][]
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
