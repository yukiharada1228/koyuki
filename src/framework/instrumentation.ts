import type { StageObserver } from './workflow.js';
type Hook = (input: unknown, observe: StageObserver) => Promise<unknown>;
const hooks = new WeakMap<Function, Hook>();
/** Internal capability keyed by the exact detailed function, not a mutable command object. */
export function registerDetailed<F extends (...args: never[]) => unknown, I, R>(fn: F, perform: (input: I, observe: StageObserver) => Promise<R>): F {
  hooks.set(fn, perform as unknown as Hook); return fn;
}
export function inheritDetailed<F extends (...args: never[]) => unknown>(fn: F, source: Function): F {
  const hook = hooks.get(source); if (hook) hooks.set(fn, hook); return fn;
}
export function bindDetailedFunction<I, R>(owner: object, original: (input: I) => Promise<R>): (input: I) => Promise<R> {
  return inheritDetailed(original.bind(owner), original);
}
export function bindDetailed<I, R>(owner: { readonly runDetailed: (input: I) => Promise<R> }): (input: I) => Promise<R> {
  return bindDetailedFunction(owner, owner.runDetailed);
}
export async function invokeDetailed<I, R>(fn: (input: I) => Promise<R>, input: I, observe?: StageObserver): Promise<R> {
  // Selected-value capture retains its existing opaque IO boundary contract.
  const hook = observe?.live ? hooks.get(fn) : undefined;
  return hook ? await hook(input, observe!) as R : fn(input);
}
