import type { Result } from './result.js';
import { Workflow, type Rule } from './workflow.js';
import { defineCommand } from './command.js';
export interface Step<I, O, E> { readonly name: string; readonly rule: Rule<I, O, E> }
export function step<I, O, E>(name: string, rule: Rule<I, O, E>): Step<I, O, E> { return { name, rule }; }
type AnyStep = Step<never, unknown, unknown>;
type Output<T> = T extends Step<never, infer O, unknown> ? O : never;
type Failure<T> = T extends Step<never, unknown, infer E> ? E : never;
type End<I, T extends readonly AnyStep[]> = T extends readonly [infer H, ...infer R extends readonly AnyStep[]] ? End<Output<H>, R> : I;
type Connected<I, T extends readonly AnyStep[]> = T extends readonly [infer H extends AnyStep, ...infer R extends readonly AnyStep[]]
  ? H extends Step<infer A, unknown, unknown> ? [I] extends [A] ? readonly [H, ...Connected<Output<H>, R>] : never : never
  : readonly [];

/** A pure event transition: validation, domain requirements, evolution. No IO or manual Result plumbing. */
export function transition<I, V, VE, const T extends readonly AnyStep[], O, E>(definition: {
  validate: Step<I, V, VE>;
  require: T & Connected<NoInfer<V>, T>;
  evolve: Step<NoInfer<End<V, T>>, O, E>;
}): Workflow<I, O, VE | Failure<T[number]> | E> {
  // Type checking above proves adjacency. Runtime iteration erases only heterogeneous intermediate states.
  const stages: readonly AnyStep[] = [definition.validate, ...definition.require, definition.evolve];
  return new Workflow(definition.validate.name, stages.map(stage => stage.name), input => {
    let value: unknown = input;
    const trace: { step: string; status: 'ok' | 'error' }[] = [];
    for (const stage of stages) {
      const rule = stage.rule as (value: unknown) => Result<unknown, VE | Failure<T[number]> | E>;
      const result = rule(value);
      trace.push({ step: stage.name, status: result.ok ? 'ok' : 'error' });
      if (!result.ok) return { result, trace };
      value = result.value;
    }
    return { result: { ok: true, value: value as O }, trace };
  });
}
/** Register an operation's IO at the model boundary, then attach pure event behavior. */
export function defineTarget<I, C, LE, O, S, SE>(adapter: {
  operation: string; loadName?: string;
  load: (input: I) => Promise<Result<C, LE>>;
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
      return { ...command, decision: decide };
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
  load: (input: I) => Promise<Result<C, LE>>;
  save: (value: O, execution: RequestExecution<NoInfer<I>>) => Promise<Result<S, SE>>;
}) {
  const { operation, loadName, load, save } = adapter;
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
      return {
        decision,
        run: (request: I) => forRequest(request).run(request),
        runDetailed: (request: I) => forRequest(request).runDetailed(request),
      };
    },
  };
}
