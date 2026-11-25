import type { Result } from './result.js';

/** Synchronous hooks must not leave an owned transaction behind when begin throws. */
export interface SyncTransactionDriver<C = undefined> {
  readonly begin: (context: C | undefined) => undefined;
  readonly commit: () => undefined;
  readonly rollback: () => undefined;
}
export type TransactionEvent =
  | { readonly kind: 'started' }
  | { readonly kind: 'committed' }
  | { readonly kind: 'rolled-back'; readonly reason: 'result' | 'exception' | 'commit' }
  | { readonly kind: 'failed'; readonly phase: 'begin' | 'rollback' };
export class TransactionFailure extends Error {
  constructor(
    readonly phase: 'busy' | 'unusable' | 'begin' | 'work' | 'commit' | 'rollback',
    readonly outcome: 'not-started' | 'rolled-back' | 'unknown',
    options?: { cause: unknown },
  ) { super(`Transaction ${phase}: ${outcome}`, options); this.name = 'TransactionFailure'; }
}

/** One boundary per connection. No retries, nesting, asynchronous work or distributed IO. */
export function createSyncTransaction<C = undefined>(driver: SyncTransactionDriver<C>, observe?: (event: TransactionEvent) => void) {
  // Keep the receiver of host methods and prevent their replacement during a transaction.
  const begin = driver.begin.bind(driver), commit = driver.commit.bind(driver), rollback = driver.rollback.bind(driver);
  let active = false, unusable = false;
  const emit = (event: TransactionEvent) => {
    try {
      const pending: unknown = observe?.(Object.freeze(event));
      // Notifications begin synchronously, but void callbacks can return promises.
      // Consume rejection without waiting or changing the transaction result.
      if (pending !== undefined) void Promise.resolve(pending).catch(() => {});
    } catch { /* diagnostic only */ }
  };
  return {
    run<R extends Result<unknown, unknown>>(work: () => R, context?: C): R {
      if (unusable) throw new TransactionFailure('unusable', 'unknown');
      if (active) throw new TransactionFailure('busy', 'not-started');
      active = true;
      const undo = (reason: 'result' | 'exception' | 'commit') => {
        try { rollback(); }
        catch (cause) {
          unusable = true;
          emit({ kind: 'failed', phase: 'rollback' });
          throw new TransactionFailure('rollback', 'unknown', { cause });
        }
        emit({ kind: 'rolled-back', reason });
      };
      try {
        try { begin(context); }
        catch (cause) { emit({ kind: 'failed', phase: 'begin' }); throw new TransactionFailure('begin', 'not-started', { cause }); }
        emit({ kind: 'started' });
        let result: R;
        try {
          result = work();
          // Defensive check for untyped hosts; an asynchronous callback is not a Result.
          if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new TypeError('Synchronous transaction work must return Result');
        } catch (cause) {
          undo('exception');
          throw new TransactionFailure('work', 'rolled-back', { cause });
        }
        if (!result.ok) { undo('result'); return result; }
        try { commit(); }
        catch (cause) {
          // A remote/lying adapter might have committed before throwing. Rollback success
          // alone is insufficient evidence to report that no state was persisted.
          unusable = true;
          undo('commit');
          throw new TransactionFailure('commit', 'unknown', { cause });
        }
        emit({ kind: 'committed' });
        return result;
      } finally { active = false; }
    },
  };
}

/** Host owns begin/commit/rollback and supplies a scoped connection to the callback.
 * It must reject with the identical callback exception only after rollback completes.
 * Wrapping or replacing that exception is treated as a host failure, never a Result.
 */
export interface TransactionHost<C> {
  readonly transaction: <T>(work: (context: C) => Promise<T>) => Promise<T>;
}

/** A host violated the callback protocol; the database outcome is not inferred. */
export class TransactionHostFailure extends Error {
  readonly outcome = 'unknown' as const;
  constructor(readonly reason: 'repeated-callback' | 'late-callback' | 'missing-callback' | 'unfinished-callback' | 'swallowed-failure' | 'changed-result') {
    super(`Transaction host protocol: ${reason}`); this.name = 'TransactionHostFailure';
  }
}

/** For callback-based asynchronous drivers, including interactive ORM transactions.
 * A failed Result aborts through an invocation-local marker; it is returned only
 * when the host confirms that exact abort after rolling back. Driver failures reject.
 */
export async function inTransaction<C, R extends Result<unknown, unknown>>(
  host: TransactionHost<C>, work: (context: C) => R | Promise<R>,
): Promise<R> {
  const abort = Object.freeze({});
  let invoked = false, completed = false, failed = false, closed = false;
  let original: R | undefined, violation: TransactionHostFailure | undefined;
  const invalid = (reason: TransactionHostFailure['reason']) => violation ??= new TransactionHostFailure(reason);
  try {
    const result = await host.transaction(async context => {
      if (closed) throw invalid('late-callback');
      if (invoked) throw invalid('repeated-callback');
      invoked = true;
      try {
        const value = await work(context);
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new TypeError('Transaction work must return Result');
        original = value;
        completed = true;
        if (!value.ok) { failed = true; throw abort; }
        return value;
      } catch (cause) { completed = true; failed = true; throw cause; }
    });
    if (violation) throw violation;
    if (!invoked) throw invalid('missing-callback');
    if (!completed) throw invalid('unfinished-callback');
    if (failed) throw invalid('swallowed-failure');
    if (result !== original) throw invalid('changed-result');
    return result;
  } catch (cause) {
    if (violation) throw violation;
    if (cause === abort && original && !original.ok) return original;
    throw cause;
  } finally { closed = true; }
}
