export type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
export const ok = <A>(value: A): Result<A, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Adapt synchronous exceptions at an explicit IO boundary. Does not await promises. */
export function fromThrowable<A extends unknown[], O, E>(perform: (...args: A) => O, failure: (cause: unknown) => E) {
  return (...args: A): Result<O, E> => {
    try { return ok(perform(...args)); }
    catch (cause) { return err(failure(cause)); }
  };
}

/** Adapt both synchronous throws and rejected promises from an asynchronous boundary. */
export function fromPromise<A extends unknown[], O, E>(perform: (...args: A) => PromiseLike<O>, failure: (cause: unknown) => E) {
  return async (...args: A): Promise<Result<O, E>> => {
    try { return ok(await perform(...args)); }
    catch (cause) { return err(failure(cause)); }
  };
}
