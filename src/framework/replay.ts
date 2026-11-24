import { err, ok, type Result } from './result.js';
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

/**
 * Optional command boundary. Host authentication and request-key scoping precede it.
 * The adapter owns receipt identity, output hydration, and atomic data+receipt writes.
 * This function resolves successful receipts; it never retries the command itself.
 */
export function withReplay<I, O, E, RE>(command: {
  run(input: I): Promise<Result<Execution<O>, E>>;
}, boundary: ReplayBoundary<NoInfer<I>, NoInfer<O>, NoInfer<E>, RE>) {
  // Capture hooks now, so later mutation of a caller's configuration cannot replace them.
  const runCommand = command.run.bind(command);
  const lookup = boundary.lookup.bind(boundary), resolveAfter = boundary.resolveAfter.bind(boundary);
  return {
    async run(input: I): Promise<Result<Execution<O>, E | RE | ReplayInputError>> {
      // Detach nested data before any await. Non-cloneable opaque inputs are rejected.
      let request: I;
      try { request = structuredClone(input); }
      catch { return err({ kind: 'ReplayInputNotCloneable' }); }
      const cached = await lookup(request);
      if (!cached.ok) return cached;
      if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
      const result = await runCommand(request);
      if (result.ok || !resolveAfter(result.error)) return result;
      const raced = await lookup(request);
      if (!raced.ok) return raced;
      return raced.value.kind === 'found' ? ok({ kind: 'replayed', value: raced.value.value }) : result;
    },
  };
}

/** Preserve the current projection on replay. Refreshing stale projections is host-owned. */
export function replayOperation<S, I, O, E>(command: {
  run(input: I): Promise<Result<Execution<O>, E>>;
}, reduce: (state: S, output: NoInfer<O>) => S): Operation<S, I, Execution<O>, E> {
  return operation(command, (state, execution) => execution.kind === 'replayed' ? state : reduce(state, execution.value));
}
