export type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
export const ok = <A>(value: A): Result<A, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
