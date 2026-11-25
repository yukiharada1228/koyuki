import { snapshotData } from './snapshot.js';
import type { ModelStep } from './testing.js';

export interface SequenceModel<S, E, O> {
  readonly initial: readonly S[];
  /** Generate finite choices. Use only this random source when randomness is needed. */
  readonly events: (state: S, random: () => number) => readonly E[];
  readonly step: (state: S, event: E) => ModelStep<S, O>;
  readonly check: (before: S, event: E, expected: ModelStep<S, O>) => boolean;
  readonly invariant?: (state: S) => boolean;
  /** Reference-model admissibility after deleting earlier events; not business authorization. */
  readonly accepts?: (state: S, event: E) => boolean;
  readonly seed: number;
  readonly limits: { readonly cases: number; readonly length: number; readonly shrinkAttempts: number };
}
type Phase = 'snapshot' | 'events' | 'accepts' | 'step' | 'check' | 'invariant';
type Reason = 'invariant' | 'implementation';
interface SequenceWitness<S, E> { readonly initial: S; readonly events: readonly E[] }
interface SamplingCounts { readonly seed: number; readonly cases: number; readonly transitions: number; readonly shrinkAttempts: number }
export type SequenceSampling<S, E> = SamplingCounts & (
  | { readonly kind: 'sampled' }
  | { readonly kind: 'counterexample'; readonly reason: Reason; readonly witness: SequenceWitness<S, E>; readonly original: SequenceWitness<S, E>; readonly shrink: 'one-deletion-minimal' | 'limited' }
  | { readonly kind: 'defect'; readonly phase: Phase; readonly cause: unknown; readonly witness?: SequenceWitness<S, E> }
);

/** Seeded reference-model sampling and bounded deletion shrinking. Not exhaustive or a proof. */
export function sampleModel<S, E, O>(definition: SequenceModel<S, E, O>): SequenceSampling<S, E> {
  const { events, step, check, invariant, accepts, seed } = definition;
  const limits = { ...definition.limits };
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff ||
    !Number.isSafeInteger(limits.cases) || limits.cases < 1 ||
    !Number.isSafeInteger(limits.length) || limits.length < 0 ||
    !Number.isSafeInteger(limits.shrinkAttempts) || limits.shrinkAttempts < 0) throw new RangeError('InvalidSequenceSamplingLimits');
  let randomState = seed, cases = 0, transitions = 0, shrinkAttempts = 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; };
  const counts = (): SamplingCounts => ({ seed, cases, transitions, shrinkAttempts });
  let phase: Phase = 'snapshot', current: SequenceWitness<S, E> | undefined;
  type Failure = { reason: Reason; witness: SequenceWitness<S, E> };
  const boolean = (value: unknown, message: string): boolean => { if (typeof value !== 'boolean') throw new TypeError(message); return value; };
  const valid = (state: S): boolean => {
    if (!invariant) return true;
    phase = 'invariant'; return boolean(invariant(snapshotData(state)), 'ModelInvariantMustBeBoolean');
  };
  const admissible = (state: S, event: E): boolean => {
    if (!accepts) return true;
    phase = 'accepts'; return boolean(accepts(snapshotData(state), snapshotData(event)), 'ModelAcceptsMustBeBoolean');
  };
  const edge = (state: S, event: E): { state: S; reason?: Reason } => {
    phase = 'step'; const output = step(snapshotData(state), snapshotData(event));
    phase = 'snapshot'; const expected = snapshotData(output);
    if (!expected || typeof expected !== 'object' || !('state' in expected) || !('output' in expected)) throw new TypeError('ModelStepMustContainStateAndOutput');
    phase = 'check'; const matches = boolean(check(snapshotData(state), snapshotData(event), snapshotData(expected)), 'ModelCheckMustBeBoolean');
    transitions++;
    if (!matches) return { state, reason: 'implementation' };
    phase = 'snapshot'; const next = snapshotData(expected.state);
    return { state: next, ...(!valid(next) ? { reason: 'invariant' as const } : {}) };
  };
  const replay = (witness: SequenceWitness<S, E>): Failure | undefined => {
    phase = 'snapshot'; let state = snapshotData(witness.initial);
    current = { initial: witness.initial, events: [] };
    if (!valid(state)) return { reason: 'invariant', witness: current };
    for (let index = 0; index < witness.events.length; index++) {
      const event = witness.events[index]!;
      current = { initial: witness.initial, events: witness.events.slice(0, index + 1) };
      if (!admissible(state, event)) return undefined;
      const result = edge(state, event);
      if (result.reason) return { reason: result.reason, witness: current };
      state = result.state;
    }
    return undefined;
  };
  const shrink = (failure: Failure): SequenceSampling<S, E> => {
    phase = 'snapshot'; const original = snapshotData(failure.witness);
    let witness = snapshotData(original), limited = false;
    // Descending chunks, then individual deletions. A successful deletion starts
    // the same pass again; the final pass certifies only one-deletion minimality.
    for (let chunk = witness.events.length; chunk >= 1; chunk = Math.floor(chunk / 2)) {
      let index = 0;
      while (index < witness.events.length) {
        if (shrinkAttempts >= limits.shrinkAttempts) { limited = true; break; }
        const candidate = { initial: witness.initial, events: [...witness.events.slice(0, index), ...witness.events.slice(index + chunk)] };
        shrinkAttempts++;
        const result = replay(candidate);
        if (result?.reason === failure.reason) { phase = 'snapshot'; witness = snapshotData(result.witness); index = 0; }
        else index++;
      }
      if (limited) break;
    }
    return { kind: 'counterexample', reason: failure.reason, ...counts(), original, witness, shrink: limited ? 'limited' : 'one-deletion-minimal' };
  };
  try {
    const initial = snapshotData(definition.initial);
    if (!Array.isArray(initial) || initial.length === 0) throw new TypeError('ModelInitialStatesRequired');
    for (; cases < limits.cases;) {
      cases++;
      phase = 'snapshot'; const origin: S = snapshotData(initial[Math.floor(random() * initial.length)]!);
      let state = snapshotData(origin); const path: E[] = [];
      current = { initial: origin, events: path };
      if (!valid(state)) return shrink({ reason: 'invariant', witness: current });
      for (let index = 0; index < limits.length; index++) {
        phase = 'events'; const generated = events(snapshotData(state), random);
        if (!Array.isArray(generated)) throw new TypeError('ModelEventsMustBeArray');
        phase = 'snapshot'; const choices: readonly E[] = snapshotData(generated);
        if (!choices.length) break;
        const event = choices[Math.floor(random() * choices.length)]!; path.push(event);
        current = { initial: origin, events: [...path] };
        if (!admissible(state, event)) throw new TypeError('ModelGeneratedEventNotAdmissible');
        const result = edge(state, event);
        if (result.reason) return shrink({ reason: result.reason, witness: current });
        state = result.state;
      }
    }
    return { kind: 'sampled', ...counts() };
  } catch (cause) {
    return { kind: 'defect', phase, ...counts(), cause, ...(current ? { witness: { initial: current.initial, events: [...current.events] } } : {}) };
  }
}
