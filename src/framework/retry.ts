import { snapshotData } from './snapshot.js';
import { err, type Result } from './result.js';

export type RetryDecision = { readonly kind: 'stop' } | {
  readonly kind: 'retry';
  /** Host assertion about this failed attempt, not an inference from its error name. */
  readonly safety: 'not-applied' | 'idempotent';
  readonly delayMs: number;
};
export interface RetryAttempt { readonly attempt: number; readonly signal?: AbortSignal }
export type RetryFailure<E> = { readonly kind: 'RetryInputNotCloneable' } | {
  readonly kind: 'RetryInterrupted'; readonly attempts: number; readonly lastError?: E;
};
function pause(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
/** Explicit retries for request DTOs. Exceptions reject; only classified Result errors retry.
 * The host must provide actual no-effect/idempotency guarantees (e.g. atomic receipts).
 */
export function retryEffect<I, O, E>(effect: (input: I, execution: RetryAttempt) => Promise<Result<O, E>>, policy: {
  readonly maxAttempts: number;
  readonly decide: (error: NoInfer<E>, execution: RetryAttempt) => RetryDecision;
}) {
  const maxAttempts = policy.maxAttempts, decide = policy.decide.bind(policy);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('InvalidRetryAttempts');
  return async (input: I, options: { readonly signal?: AbortSignal } = {}): Promise<Result<O, E | RetryFailure<E>>> => {
    const signal = options.signal;
    if (signal?.aborted) return err({ kind: 'RetryInterrupted', attempts: 0 });
    let request: I;
    try { request = snapshotData(input); } catch { return err({ kind: 'RetryInputNotCloneable' }); }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const execution = Object.freeze({ attempt, signal });
      const result = await effect(snapshotData(request), execution);
      // A completed success may have committed. Cancellation never hides it.
      if (result.ok) return result;
      if (signal?.aborted) return err({ kind: 'RetryInterrupted', attempts: attempt, lastError: result.error });
      if (attempt === maxAttempts) return result;
      const decision = decide(result.error, execution);
      if (decision.kind === 'stop') return result;
      if (decision.kind !== 'retry' || !['not-applied', 'idempotent'].includes(decision.safety) ||
        !Number.isSafeInteger(decision.delayMs) || decision.delayMs < 0 || decision.delayMs > 2147483647) throw new TypeError('InvalidRetryDecision');
      if (signal?.aborted) return err({ kind: 'RetryInterrupted', attempts: attempt, lastError: result.error });
      await pause(decision.delayMs, signal);
      if (signal?.aborted) return err({ kind: 'RetryInterrupted', attempts: attempt, lastError: result.error });
    }
    throw new Error('RetryAttemptsExhausted');
  };
}
