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
type Output<T> = T extends Step<never, infer O, unknown> ? O : never;
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
type StageEnd<I, T extends readonly AnyStage[]> = T extends readonly [infer H, ...infer R extends readonly AnyStage[]] ? StageEnd<StageOutput<H>, R> : I;
type ConnectedStages<I, T extends readonly AnyStage[]> = T extends readonly [infer H extends AnyStage, ...infer R extends readonly AnyStage[]]
  ? readonly [Stage<I, StageOutput<H>, StageFailure<H>>, ...ConnectedStages<StageOutput<H>, R>]
  : readonly [];
type NamedStages<T extends readonly AnyStage[]> = { readonly [K in keyof T]: Step<StageInput<T[K]>, StageOutput<T[K]>, StageFailure<T[K]>> };
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
  require?: T & ConnectedStages<StageOutput<NoInfer<A>>, T>;
  evolve: Stage<NoInfer<StageEnd<StageOutput<A>, T>>, O, E>;
}): {
  readonly validate: Step<StageInput<A>, StageOutput<A>, StageFailure<A>>;
  readonly require: NamedStages<T>;
  readonly evolve: Step<StageEnd<StageOutput<A>, T>, O, E>;
} {
  // Adjacency is proved by the declaration. JS map erases only tuple positions.
  const stages: readonly AnyStage[] = definition.require ?? [];
  const requirements = Object.freeze(stages.map((stage, index) => named(stage, `require:${index + 1}`))) as NamedStages<T>;
  const validation = definition.validate as Stage<StageInput<A>, StageOutput<A>, StageFailure<A>>;
  return Object.freeze({ validate: named(validation, 'validate'), require: requirements, evolve: named(definition.evolve, 'evolve') });
}

/** Carry the original input alongside a successful requirement, without Result plumbing.
 * Only the pair is frozen. Domain values and purity remain the caller's responsibility.
 */
export function withInput<I, O, E>(rule: Rule<I, O, E>): (input: I) => Result<Readonly<{ input: I; value: O }>, E> {
  return input => {
    const result = rule(input);
    return result.ok ? { ok: true, value: Object.freeze({ input, value: result.value }) } : result;
  };
}
