import { bindDetailed, invokeDetailed, registerDetailed } from './instrumentation.js';
import { registerStructure, structureOf, structureSequence, structureStep, loadStructure } from './structure.js';
import { captureLoad, type ActionLoad } from './action.js';
import type { Result } from './result.js';
import { Workflow, evaluateRule, type Rule } from './workflow.js';
import { defineCommand } from './command.js';
export interface Step<I, O, E> { readonly name: string; readonly rule: Rule<I, O, E> }
type StepRule<F> = Extract<F, Rule<never, unknown, unknown>>;
type StepInput<F extends object> = Parameters<StepRule<F>>[0];
type StepSuccess<F extends object> = ReturnType<StepRule<F>> extends infer R ? R extends { ok: true; value: infer O } ? O : never : never;
type StepError<F extends object> = ReturnType<StepRule<F>> extends infer R ? R extends { ok: false; error: infer E } ? E : never : never;
type CheckedStepRule<F extends object> = [F] extends [Rule<StepInput<F>, StepSuccess<F>, StepError<F>>] ? unknown : never;
type StepUnion<F, C = F> = F extends C ? [C] extends [F] ? false : true : never;
// Keep a concrete callable's generic relationships. Dynamic alternatives retain
// the established aggregate Result contract rather than exposing a union of calls.
type RetainedStep<F extends object> = true extends StepUnion<F>
  ? Step<StepInput<F>, StepSuccess<F>, StepError<F>>
  : { readonly name: string; readonly rule: F };
// Capture a callable before a contextual signature can instantiate its generic
// parameters as unknown. Later signatures retain contextual callback inference.
// Infer the callable from the argument, not from an enclosing stage table's
// broad expected return. That context must not instantiate nested withInput as never.
export function step<F extends object>(name: string, rule: F & NoInfer<CheckedStepRule<F>>): NoInfer<RetainedStep<F>>;
export function step<I, O, E, F extends object>(name: string, rule: Rule<I, O, E> & F & NoInfer<CheckedStepRule<F>>): NoInfer<RetainedStep<F>>;
// Keep reflection through Parameters/ReturnType on the original signature.
export function step<I, O, E>(name: string, rule: Rule<I, O, E>): Step<I, O, E>;
export function step<I, O, E>(name: string, rule: Rule<I, O, E>): Step<I, O, E> { return { name, rule }; }
type AnyStep = Step<never, unknown, unknown>;
// The callable already declares the specialized success; do not infer it again
// through a Step shape when consuming a normalized transition definition.
type Output<T> = ReturnType<Extract<T, AnyStep>['rule']> extends infer R
  ? R extends { ok: true; value: infer O } ? O : never : never;
type Failure<T> = T extends Step<never, unknown, infer E> ? E : never;
type End<I, T extends readonly AnyStep[]> = T extends readonly [infer H, ...infer R extends readonly AnyStep[]] ? End<Output<H>, R> : I;
// Express the expected input at each slot, rather than collapsing a bad chain to never.
type Connected<I, T extends readonly AnyStep[]> = T extends readonly [infer H extends AnyStep, ...infer R extends readonly AnyStep[]]
  ? readonly [Step<I, Output<H>, Failure<H>>, ...Connected<Output<H>, R>]
  : readonly [];

export type TransitionDefinition<I, V, VE, T extends readonly AnyStep[], O, E> = {
  validate: Step<I, V, VE>;
  require: T & Connected<NoInfer<V>, T>;
  evolve: Step<NoInfer<End<V, T>>, O, E>;
};

/** A pure event transition: validation, domain requirements, evolution. No IO or manual Result plumbing. */
export function transition<I, V, VE, const T extends readonly AnyStep[], O, E>(definition: {
  validate: Step<I, V, VE>;
  require: T & Connected<NoInfer<V>, T>;
  evolve: Step<NoInfer<End<V, T>>, O, E>;
}): Workflow<I, O, VE | Failure<T[number]> | E> {
  // Type checking above proves adjacency. Runtime iteration erases only heterogeneous intermediate states.
  const stages: readonly AnyStep[] = Object.freeze([definition.validate, ...definition.require, definition.evolve].map(stage => Object.freeze({ name: stage.name, rule: stage.rule })));
  return registerStructure(new Workflow(stages[0]!.name, stages.map(stage => stage.name), (input, observe) => {
    let value: unknown = input;
    const trace: { step: string; status: 'ok' | 'error' }[] = [];
    for (const stage of stages) {
      const rule = stage.rule as (value: unknown) => Result<unknown, VE | Failure<T[number]> | E>;
      const result = evaluateRule(stage.name, rule, value, observe);
      trace.push({ step: stage.name, status: result.ok ? 'ok' : 'error' });
      if (!result.ok) return { result, trace };
      value = result.value;
    }
    return { result: { ok: true, value: value as O }, trace };
  }), structureSequence(...stages.map((stage, index) => structureStep(stage.name, index === 0 ? 'validate' : index === stages.length - 1 ? 'evolve' : 'require'))));
}
/** Register an operation's IO at the model boundary, then attach pure event behavior. */
export function defineTarget<I, C, LE, O, S, SE>(adapter: {
  operation: string; loadName?: string;
  load: ActionLoad<I, C, LE>;
  save: (value: O) => Promise<Result<S, SE>>;
}) {
  return {
    on<VE, V, const T extends readonly AnyStep[], E>(definition: {
      validate: Step<C, V, VE>;
      require: T & Connected<NoInfer<V>, T>;
      evolve: Step<NoInfer<End<V, T>>, NoInfer<O>, E>;
    }) {
      const decide = transition(definition);
      const command = defineCommand({ ...adapter, decide });
      return registerStructure({ ...command, decision: decide }, structureOf(command));
    },
  };
}

/** Host request metadata stays outside the pure domain decision. */
export interface RequestExecution<I> {
  readonly operation: string;
  readonly request: I;
}
/** A request-bound target deliberately exposes no context-free mutation escape hatch.
 * Input ownership follows defineCommand; use withReplay for a cloned request snapshot.
 */
export function defineRequestTarget<I, C, LE, O, S, SE>(adapter: {
  operation: string; loadName?: string;
  load: ActionLoad<I, C, LE>;
  save: (value: O, execution: RequestExecution<NoInfer<I>>) => Promise<Result<S, SE>>;
}) {
  const { operation, loadName, save } = adapter;
  const load = captureLoad(adapter.load);
  return {
    on<VE, V, const T extends readonly AnyStep[], E>(definition: {
      validate: Step<C, V, VE>;
      require: T & Connected<NoInfer<V>, T>;
      evolve: Step<NoInfer<End<V, T>>, NoInfer<O>, E>;
    }) {
      const decision = transition(definition);
      function forRequest(request: I) {
        const execution = Object.freeze({ operation, request });
        return defineCommand({ operation, loadName, load, decide: decision,
          save: (value: O) => save(value, execution) });
      }
      return registerStructure({
        decision,
        run: (request: I) => forRequest(request).run(request),
        runDetailed: registerDetailed((request: I) => forRequest(request).runDetailed(request), (request: I, observe) => invokeDetailed(bindDetailed(forRequest(request)), request, observe)),
      }, structureSequence(loadStructure(load, loadName ?? `${operation}:load`), structureOf(decision), structureStep(operation, 'save')));
    },
  };
}

type Stage<I, O, E> = Step<I, O, E> | Rule<I, O, E>;
type AnyStage = Stage<never, unknown, unknown>;
type StageCall<T> = T extends (...args: never[]) => unknown ? T : T extends { readonly rule: infer F } ? F : never;
// Normalize ordinary/named candidates before contravariant input inference.
type StageInput<T> = [StageCall<T>] extends [(input: infer I) => unknown] ? I : never;
type StageOutput<T> = T extends Stage<never, infer O, unknown> ? O : never;
type StageFailure<T> = T extends Stage<never, unknown, infer E> ? E : never;
type PairShape<O, I, Both extends boolean> = {
  [K in keyof O]: K extends 'input' ? I : Both extends true ? K extends 'value' ? I : O[K] : O[K]
};
type InputPairOutput<F, I, O, E> = [StageCall<F>] extends [(input: I) => Result<PairShape<O, I, false>, E>]
  ? [PairShape<O, I, false>] extends [O] ? PairShape<O, I, false> : O : O;
// Keep already-concrete pairs exactly as declared, including a scoped generic
// caller's T. Only specialize a wider pair if its actual producer promises the
// candidate for this input, and the candidate retains all declared output facts.
type ContextPairOutput<F, I, O, E> = [O] extends [{ readonly input: I; readonly value: unknown }] ? O
  : [O] extends [{ readonly input: unknown; readonly value: unknown }]
    ? [StageCall<F>] extends [(input: I) => Result<PairShape<O, I, true>, E>]
      ? [PairShape<O, I, true>] extends [O] ? PairShape<O, I, true> : InputPairOutput<F, I, O, E>
      : InputPairOutput<F, I, O, E>
    : O;
type PairWithValue<O, I, V> = { [K in keyof O]: K extends 'input' ? I : K extends 'value' ? V : O[K] };
type ValueField<V, K, T> = { [P in keyof V]: P extends K ? T & V[P] : V[P] };
// Check each field against the whole declared value, including every union
// variant. Intersect with its declared facts, rather than replacing those facts.
// Generic signature comparison can accept an object union as T & that union.
// Reject that false correlation with an independent concrete primitive input.
// Capture the witness result before the generic conditional narrows the rule.
// This is an extra refusal check, not a proof of TypeScript soundness.
declare const correlationWitness: unique symbol;
type ValueFieldWitness<F, O, V, K, E> = [StageCall<F>] extends [(input: typeof correlationWitness) => Result<PairWithValue<O, typeof correlationWitness, ValueField<V, K, typeof correlationWitness>>, E>] ? true : false;
type CorrelatedValueField<F, O, V, K extends keyof V, I, E, Whole, Witness = ValueFieldWitness<F, O, Whole, K, E>> =
  [StageCall<F>] extends [<T>(input: T) => Result<PairWithValue<O, T, ValueField<Whole, K, T>>, E>]
    ? Witness extends true ? I & V[K] : V[K] : V[K];
type UniversalValueFields<F, O, V, I, E, Whole = V> = {
  [K in keyof V]: CorrelatedValueField<F, O, V, K, I, E, Whole>
};
type UniversalValuePair<F, I, O, E> = [O] extends [{ readonly input: unknown; readonly value: infer V }]
  ? [V] extends [object]
    ? [PairWithValue<O, I, UniversalValueFields<F, O, V, I, E>>] extends [O]
      // Individually valid refinements may select different overlapping union
      // branches. Require the producer to promise their combined shape as well.
      ? [StageCall<F>] extends [<T>(input: T) => Result<PairWithValue<O, T, UniversalValueFields<F, O, V, T, E>>, E>]
        ? PairWithValue<O, I, UniversalValueFields<F, O, V, I, E>> : PairShape<O, I, false>
      : PairShape<O, I, false>
    : PairShape<O, I, false>
  : PairShape<O, I, false>;
// Prove an unconstrained producer's promise for every T before comparing its
// broad output with a caller's still-generic I. That comparison may be deferred.
// The subtype guards retain output facts; ordinary/bounded producers continue
// through the concrete-context checks above.
/** Internal shared inference; deliberately absent from the package entry point. */
export type UniversalRuleOutput<R, I, O, E, Fallback> = [R] extends [<T>(input: T) => Result<PairShape<O, T, true>, E>]
  ? [PairShape<O, I, true>] extends [O] ? PairShape<O, I, true> : Fallback
  : [R] extends [<T>(input: T) => Result<PairShape<O, T, false>, E>]
    ? [PairShape<O, I, false>] extends [O] ? UniversalValuePair<R, I, O, E> : Fallback
    : Fallback;
// Determine correlation independently of the caller's still-generic input.
// Distribute keys across variants, but test each key against the entire union.
type RecordFieldWitness<R, Whole, K, E> = [R] extends [(input: typeof correlationWitness) => Result<ValueField<Whole, K, typeof correlationWitness>, E>] ? true : false;
type CorrelatedRecordKey<R, Whole, K, E, Witness = RecordFieldWitness<R, Whole, K, E>> =
  [R] extends [<T>(input: T) => Result<ValueField<Whole, K, T>, E>] ? Witness extends true ? K : never : never;
type CorrelatedKeys<R, O, E, Whole = O> = O extends unknown
  ? { [K in keyof O]-?: CorrelatedRecordKey<R, Whole, K, E> }[keyof O] : never;
type UniversalRecordFields<R, O, I, E, Keys = CorrelatedKeys<R, O, E>> = {
  [K in keyof O]: K extends Keys ? I & O[K] : O[K]
};
/** Internal ordinary-record inference; not exported by the package entry point. */
export type UniversalRecordOutput<R, I, O, E, Fallback> = [O] extends [object]
  ? [UniversalRecordFields<R, O, I, E>] extends [O]
    ? [R] extends [<T>(input: T) => Result<UniversalRecordFields<R, O, T, E>, E>]
      ? [R] extends [(input: I) => Result<UniversalRecordFields<R, O, I, E>, E>]
        ? UniversalRecordFields<R, O, I, E> : Fallback
      : Fallback
    : Fallback : Fallback;
type PairOutput<F, I, O = StageOutput<F>, E = StageFailure<F>> = [O] extends [{ readonly input: unknown; readonly value: unknown }]
  ? UniversalRuleOutput<StageCall<F>, I, O, E, ContextPairOutput<F, I, O, E>>
  : UniversalRecordOutput<StageCall<F>, I, O, E, ContextPairOutput<F, I, O, E>>;
type StageEnd<I, T extends readonly AnyStage[]> = T extends readonly [infer H, ...infer R extends readonly AnyStage[]] ? StageEnd<PairOutput<H, I>, R> : I;
type ConnectedStages<I, T extends readonly AnyStage[]> = T extends readonly [infer H extends AnyStage, ...infer R extends readonly AnyStage[]]
  ? readonly [Stage<I, PairOutput<H, I>, StageFailure<H>>, ...ConnectedStages<PairOutput<H, I>, R>]
  : readonly [];
type NamedStages<T extends readonly AnyStage[], I, A extends readonly AnyStep[] = readonly []> = number extends T['length']
  ? { readonly [K in keyof T]: Step<I, PairOutput<T[K], I>, StageFailure<T[K]>> }
  : T extends readonly [infer H extends AnyStage, ...infer R extends readonly AnyStage[]]
    ? NamedStages<R, PairOutput<H, I>, readonly [...A, Step<I, PairOutput<H, I>, StageFailure<H>>]> : A;
function named<I, O, E>(stage: Stage<I, O, E>, name: string): Step<I, O, E> {
  return Object.freeze(typeof stage === 'function' ? step(name, stage) : step(stage.name, stage.rule));
}
/** Declare ordinary domain functions, normalizing into the existing transition definition.
 * Default labels describe roles and positions; they do not depend on function names/minification.
 */
export function defineTransition<const A extends object, const T extends readonly AnyStage[] = readonly [], O = unknown, E = never>(definition: {
  // Infer the supplied value before checking its stage contract; contextual Rule<never,...>
  // otherwise contaminates nested generic calls such as collectEach(validateLine).
  validate: A & NoInfer<A extends AnyStage ? unknown : never>;
  require?: T & NoInfer<ConnectedStages<StageOutput<NoInfer<A>>, T>>;
  evolve: Stage<NoInfer<StageEnd<StageOutput<A>, T>>, O, E>;
}): {
  readonly validate: Step<StageInput<A>, StageOutput<A>, StageFailure<A>>;
  readonly require: NamedStages<T, StageOutput<A>>;
  readonly evolve: Step<StageEnd<StageOutput<A>, T>, O, E>;
} {
  // Adjacency is proved by the declaration. JS map erases only tuple positions.
  const stages: readonly AnyStage[] = definition.require ?? [];
  const requirements = Object.freeze(stages.map((stage, index) => named(stage, `require:${index + 1}`))) as NamedStages<T, StageOutput<A>>;
  const validation = definition.validate as Stage<StageInput<A>, StageOutput<A>, StageFailure<A>>;
  return Object.freeze({ validate: named(validation, 'validate'), require: requirements, evolve: named(definition.evolve, 'evolve') });
}

type RequirementValue<R> = R extends { ok: true; value: infer V } ? V : never;
type RequirementError<R> = R extends { ok: false; error: infer E } ? E : never;
// Capture the whole result before extracting errors. Inferring E directly from
// unrelated object error variants can select only the first variant. One public
// signature keeps native higher-order generic propagation; the implementation
// signature is not an additional callable overload. Three explicit type arguments
// retain their existing meaning through R's default.
/** Carry the original input alongside a successful requirement, without Result plumbing.
 * Only the pair is frozen. Domain values and purity remain the caller's responsibility.
 */
export function withInput<I, O, E, R extends Result<O, E> = Result<O, E>>(rule: (input: I) => R): (input: I) => Result<Readonly<{ input: I; value: RequirementValue<R> }>, RequirementError<R>>;
export function withInput<I, O, E>(rule: Rule<I, O, E>): (input: I) => Result<Readonly<{ input: I; value: O }>, E> {
  return input => {
    const result = rule(input);
    return result.ok ? { ok: true, value: Object.freeze({ input, value: result.value }) } : result;
  };
}
