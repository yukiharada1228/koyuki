/** Explicit, finite model exploration. This entry point is separate from the business runtime. */
export interface ModelStep<S, O> { readonly state: S; readonly output: O }
export interface ModelLimits { readonly depth: number; readonly states: number; readonly transitions: number }
export interface FiniteModel<S, E, O> {
  readonly initial: readonly S[];
  /** Equal keys must mean equivalent future behavior and implementation checks. */
  readonly key: (state: S) => string;
  readonly events: (state: S) => readonly E[];
  readonly step: (state: S, event: E) => ModelStep<S, O>;
  /** Compare the independent model's edge with the implementation. Never inferred from step. */
  readonly check: (before: S, event: E, expected: ModelStep<S, O>) => boolean;
  readonly invariant?: (state: S) => boolean;
  readonly limits: ModelLimits;
}
interface Counts { readonly states: number; readonly transitions: number; readonly maxDepth: number }
interface Witness<S, E> { readonly initial: S; readonly events: readonly E[] }
export type ModelExploration<S, E> = Counts & (
  | { readonly kind: 'passed' }
  | { readonly kind: 'limited'; readonly limits: readonly ('depth' | 'states' | 'transitions')[] }
  | { readonly kind: 'counterexample'; readonly reason: 'invariant' | 'implementation'; readonly witness: Witness<S, E> }
  | { readonly kind: 'defect'; readonly phase: 'snapshot' | 'key' | 'events' | 'step' | 'check' | 'invariant'; readonly witness?: Witness<S, E>; readonly cause: unknown }
);

/**
 * Breadth-first exploration of an explicitly supplied model. States, events and
 * outputs must support structuredClone. Each callback receives its own copy.
 * Callback purity, key equivalence and implementation-check fidelity are host contracts.
 */
export function exploreModel<S, E, O>(definition: FiniteModel<S, E, O>): ModelExploration<S, E> {
  const { key, events, step, check, invariant } = definition;
  const limits = { ...definition.limits };
  if (!Number.isSafeInteger(limits.depth) || limits.depth < 0 ||
    !Number.isSafeInteger(limits.states) || limits.states < 1 ||
    !Number.isSafeInteger(limits.transitions) || limits.transitions < 1) throw new RangeError('InvalidModelLimits');
  type Entry = { state: S; initial: S; path: readonly E[] };
  const queue: Entry[] = [], seen = new Set<string>(), cutoffs = new Set<'depth' | 'states' | 'transitions'>();
  let transitions = 0, maxDepth = 0;
  const counts = () => ({ states: queue.length, transitions, maxDepth });
  const witness = (entry: Entry): Witness<S, E> => structuredClone({ initial: entry.initial, events: entry.path });
  const fault = (phase: 'snapshot' | 'key' | 'events' | 'step' | 'check' | 'invariant', entry: Entry | undefined, cause: unknown): ModelExploration<S, E> =>
    ({ kind: 'defect', phase, ...counts(), ...(entry ? { witness: { initial: entry.initial, events: entry.path } } : {}), cause });
  let phase: 'snapshot' | 'key' | 'events' | 'step' | 'check' | 'invariant' = 'snapshot';
  let current: Entry | undefined;
  try {
    const initial = structuredClone(definition.initial);
    if (!Array.isArray(initial) || initial.length === 0) throw new TypeError('ModelInitialStatesRequired');
    for (const state of initial) {
      current = { state, initial: state, path: [] };
      if (invariant) {
        phase = 'invariant'; const valid = invariant(structuredClone(state));
        if (typeof valid !== 'boolean') throw new TypeError('ModelInvariantMustBeBoolean');
        if (!valid) return { kind: 'counterexample', reason: 'invariant', ...counts(), witness: witness(current) };
      }
      phase = 'key'; const id = key(structuredClone(state));
      if (typeof id !== 'string') throw new TypeError('ModelKeyMustBeString');
      if (seen.has(id)) continue;
      if (queue.length >= limits.states) { cutoffs.add('states'); continue; }
      seen.add(id); queue.push(current);
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      current = queue[cursor]!; maxDepth = Math.max(maxDepth, current.path.length);
      phase = 'events'; const possible = events(structuredClone(current.state));
      if (!Array.isArray(possible)) throw new TypeError('ModelEventsMustBeArray');
      phase = 'snapshot'; const pending: readonly E[] = structuredClone(possible);
      if (current.path.length >= limits.depth) { if (pending.length) cutoffs.add('depth'); continue; }
      const before = current;
      for (const event of pending) {
        current = { ...before, path: [...before.path, event] };
        if (transitions >= limits.transitions) { cutoffs.add('transitions'); break; }
        phase = 'step';
        const expected = step(structuredClone(before.state), structuredClone(event));
        phase = 'snapshot'; const owned = structuredClone(expected);
        if (!owned || typeof owned !== 'object' || !('state' in owned) || !('output' in owned)) throw new TypeError('ModelStepMustContainStateAndOutput');
        phase = 'check'; const matches = check(structuredClone(before.state), structuredClone(event), structuredClone(owned));
        transitions++; maxDepth = Math.max(maxDepth, current.path.length);
        if (typeof matches !== 'boolean') throw new TypeError('ModelCheckMustBeBoolean');
        if (!matches) return { kind: 'counterexample', reason: 'implementation', ...counts(), witness: witness(current) };
        phase = 'snapshot'; const next = structuredClone(owned.state);
        // Check every reached state, even when its key aliases an existing node
        // or the state budget prevents it from being enqueued.
        if (invariant) {
          phase = 'invariant'; const valid = invariant(structuredClone(next));
          if (typeof valid !== 'boolean') throw new TypeError('ModelInvariantMustBeBoolean');
          if (!valid) return { kind: 'counterexample', reason: 'invariant', ...counts(), witness: witness(current) };
        }
        phase = 'key'; const id = key(structuredClone(next));
        if (typeof id !== 'string') throw new TypeError('ModelKeyMustBeString');
        if (seen.has(id)) continue;
        if (queue.length >= limits.states) { cutoffs.add('states'); continue; }
        seen.add(id); queue.push({ state: next, initial: before.initial, path: current.path });
      }
      if (cutoffs.has('transitions')) break;
    }
    return cutoffs.size ? { kind: 'limited', ...counts(), limits: [...cutoffs] } : { kind: 'passed', ...counts() };
  } catch (cause) { return fault(phase, current, cause); }
}
