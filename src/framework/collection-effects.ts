import { ok, err, type Result } from './result.js';
/** Explicit bounded IO collection. Domain failures are collected; defects stop new work.
 * Already-started effects are awaited before a defect is rethrown. No implicit retries/rollback.
 */
export function collectEffects<I, O, E>(perform: (item: I, index: number) => Promise<Result<O, E>>, options: { readonly concurrency: number }) {
  const concurrency = options.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('InvalidEffectConcurrency');
  return async (input: readonly I[]): Promise<Result<readonly O[], readonly { readonly index: number; readonly error: E }[]>> => {
    const items = [...input], values: O[] = [];
    const failures: { readonly index: number; readonly error: E }[] = [];
    let cursor = 0, crashed = false, defect: unknown;
    async function worker(): Promise<void> {
      while (!crashed && cursor < items.length) {
        const index = cursor++;
        try {
          const result = await perform(items[index]!, index);
          if (result.ok) values[index] = result.value;
          else failures.push(Object.freeze({ index, error: result.error }));
        } catch (cause) {
          if (!crashed) { crashed = true; defect = cause; }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    if (crashed) throw defect;
    return failures.length ? err(Object.freeze(failures.sort((a, b) => a.index - b.index))) : ok(Object.freeze(values));
  };
}
