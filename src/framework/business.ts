import { inheritDetailed } from './instrumentation.js';
import { isPlainRecord } from './snapshot.js';
import { registerStructure, structureOf, structureSequence } from './structure.js';
import { captureLoad, type ActionLoad } from './action.js';
// Declare business operations over the shared command and replay runtime.
import { workflow, Workflow, observeEvaluation, type Evaluation, type WorkflowCapture, type Rule, type StageObserver, type StageReceiver } from './workflow.js';
import type { Result } from './result.js';
import type { Step, UniversalRuleOutput, UniversalRecordOutput } from './model.js';
import type { GroupExecution } from './use-case-group.js';
import type { Receipt, Execution } from './replay.js';
import { createObservation, observeEffect, type ObservationReport } from './observation.js';
import { createGroupRuntime } from './group-runtime.js';
import type { PlainCommand, ReplayCommand, ReplaySaveCheck, SelectCommand } from './use-case.js';
type Fn = Rule<never, unknown, unknown>;
type Load = ActionLoad<never, unknown, unknown>;
type Stage = Fn | Step<never, unknown, unknown> | Workflow<never, unknown, unknown>;
type RuleOf<F extends Stage> = F extends Fn ? F : F extends Step<never, unknown, unknown> ? F['rule'] : F extends Workflow<never, unknown, unknown> ? F['run'] : never;
type Pipeline = readonly [Stage, ...Stage[]];
type Entry = Pipeline | { readonly load: Load; readonly run: Pipeline };
// A shared loader is unnecessary only when every declared operation owns one.
type SharedLoad<L extends Load, T extends Record<string, Entry>> =
  [T[keyof T]] extends [{ readonly load: Load; readonly run: Pipeline }] ? unknown : { readonly load: L };
// A dynamically selected loader must accept the request in every possible branch.
type LoadCall<L> = L extends (input: never) => unknown ? L : L extends { runDetailed: infer F } ? F : never;
type Input<L> = [LoadCall<L>] extends [(input: infer I) => unknown] ? I : never;
type LoadResult<L> = L extends (input: never) => infer R ? Awaited<R>
  : L extends { runDetailed: (input: never) => infer D } ? Awaited<D> extends { result: infer R } ? R : never : never;
type Value<R> = R extends { ok: true; value: infer O } ? O : never;
type Failure<R> = R extends { ok: false; error: infer E } ? E : never;
type Loaded<L extends Load> = Value<LoadResult<L>>;
type LoadError<L extends Load> = Failure<LoadResult<L>>;
type Out<F extends Stage> = Value<ReturnType<RuleOf<F>>>;
type ErrorOf<F extends Stage> = Failure<ReturnType<RuleOf<F>>>;
type Stages<E extends Entry> = E extends Pipeline ? E : E extends { run: infer P extends Pipeline } ? P : never;
type RawLoader<L extends Load, E extends Entry> = E extends { load: infer P extends Load } ? P : L;
type FirstInput<E extends Entry> = RuleOf<Stages<E>[0]> extends (input: infer I) => unknown ? I : never;
// Keep every previously compatible loader unchanged. For an incompatible generic
// envelope, consider the first rule's input field only as a request candidate.
// The actual loader must guarantee the entire required context for that request;
// an incompatible broad return or a missing proof remains rejected.
// Capture declared input and result before conditional matching refines the
// callable. A broad overload must not erase a narrower operation/metadata input.
type DeclaredInput<R> = [R] extends [(input: infer I) => unknown] ? I : never;
// Capture the declared input before a variance comparison can refine the rule.
// A bivariant method accepting a narrower context must not erase request fields.
type AcceptsEveryInput<R, P = DeclaredInput<R>> = [R] extends [Rule<unknown, unknown, unknown>]
  ? [unknown] extends [P] ? true : false : false;
type AcceptsLoaded<R extends (...args: never[]) => unknown, I, P = DeclaredInput<R>, O = ReturnType<R>> = [I] extends [P]
  ? R extends (input: I) => infer A ? [A] extends [O] ? true : false : false : false;
// A rule accepting every input needs no loader specialization. Decide this
// before a still-generic loaded type can defer the same keep-loader result.
type SpecializedLoader<L extends Load, E extends Entry> = AcceptsEveryInput<RuleOf<Stages<E>[0]>> extends true ? L
  : AcceptsLoaded<RuleOf<Stages<E>[0]>, Loaded<L>> extends true ? L
  : [Loaded<L>] extends [FirstInput<E>] ? L
  : [FirstInput<E>] extends [{ readonly input: infer I }]
    ? [I] extends [Input<L>]
      ? [L] extends [(input: I) => Promise<Result<FirstInput<E>, LoadError<L>>>]
        ? (input: I) => Promise<Result<FirstInput<E>, LoadError<L>>> : L
      : L
    : L;
type Loader<L extends Load, E extends Entry> = SpecializedLoader<RawLoader<L, E>, E>;
type OperationName<K> = K extends string ? K : K extends number ? number extends K ? string : `${K}` : never;
type OperationNames<T> = OperationName<keyof T>;
// A polymorphic check may promise to return exactly its input type. Retain that
// type only when the actual function guarantees it for this preceding context.
// A proof-producing check may additionally retain its declared facts, but only
// when the actual function guarantees the entire intersection. A monomorphic
// broad return must never invent a narrower success value.
// Refine only toward a subtype of each existing input member. A domain rule
// may have added validation facts; never replace those with a broader context.
type InputPairCandidate<O, I> = { [K in keyof O]: K extends 'input' ? I : O[K] };
// Keep the original success/error types stable while checking the candidate.
// A projection may carry the previous pair's input rather than the whole pair.
// Require the same producer promise and subtype guard for that inner context.
type NestedPairOutput<R extends (...args: never[]) => unknown, I, O, E> = [I] extends [{ readonly input: infer P }]
  ? R extends (input: I) => Result<InputPairCandidate<O, P>, E>
    ? [InputPairCandidate<O, P>] extends [O] ? InputPairCandidate<O, P> : O : O
  : O;
type PairRuleOutput<R extends (...args: never[]) => unknown, I, O = Value<ReturnType<R>>, E = Failure<ReturnType<R>>> = R extends (input: I) => Result<InputPairCandidate<O, I>, E>
  ? [InputPairCandidate<O, I>] extends [O] ? InputPairCandidate<O, I> : NestedPairOutput<R, I, O, E> : NestedPairOutput<R, I, O, E>;
// A generic projection can preserve members of the preceding pair's value.
// Capture the declared output first and require the actual producer to promise
// the narrower shape; the next consumer alone cannot supply that guarantee.
type PairValueRuleOutput<R extends Fn, I, O = Value<ReturnType<R>>, E = Failure<ReturnType<R>>> = [I] extends [{ readonly value: infer V }]
  ? [ShapeCandidate<V, O>] extends [never] ? O
    : R extends (input: I) => Result<ShapeCandidate<V, O>, E> ? ShapeCandidate<V, O> : O
  : O;
type InputPairOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }] ? PairRuleOutput<RuleOf<F>, I> : PairValueRuleOutput<RuleOf<F>, I>;
type ContextStageOutput<F extends Stage, I> = [Out<F>] extends [I] ? Out<F>
  : [I] extends [Out<F>]
    ? [RuleOf<F>] extends [Rule<I, I, ErrorOf<F>>] ? I : InputPairOutput<F, I>
    : [RuleOf<F>] extends [Rule<I, I & Out<F>, ErrorOf<F>>] ? I & Out<F> : InputPairOutput<F, I>;
type StageOutput<F extends Stage, I> = [Out<F>] extends [{ readonly input: unknown; readonly value: unknown }]
  ? UniversalRuleOutput<RuleOf<F>, I, Out<F>, ErrorOf<F>, ContextStageOutput<F, I>>
  : UniversalRecordOutput<RuleOf<F>, I, Out<F>, ErrorOf<F>, ContextStageOutput<F, I>>;
// Tail recursion carries the concrete context across generic identity checks.
// Unknown-length arrays retain the original mapped fallback.
type Outputs<C, P extends readonly Stage[], A extends readonly unknown[] = readonly []> = number extends P['length']
  ? { readonly [K in keyof P]: Out<P[K]> }
  : P extends readonly [infer F extends Stage, ...infer R extends readonly Stage[]]
    ? Outputs<StageOutput<F, C>, R, readonly [...A, StageOutput<F, C>]> : A;
type Inputs<C, P extends readonly Stage[]> = readonly [C, ...Outputs<C, P>];
type Tail<P extends readonly Stage[]> = P extends readonly [Stage, ...infer T extends readonly Stage[]] ? T : readonly [];
// Keep the actual function contract even in the error branch. The marker is
// diagnostic-only: adding a property cannot make an incompatible rule valid.
type DiagnosticRule<F extends Stage, I, O, Operation extends string, Index extends PropertyKey> =
  ([RuleOf<F>] extends [(input: I) => Result<O, ErrorOf<F>>] ? unknown : {
    readonly [K in `Koyuki: ${Operation}[${Extract<Index, string | number>}] ${[RuleOf<F>] extends [Rule<I, Out<F>, ErrorOf<F>>] ? 'output must match save' : 'input must accept prior output'}`]: never
  }) & (F extends Fn ? Rule<I, O, ErrorOf<F>> : F extends Step<never, unknown, unknown> ? Step<I, O, ErrorOf<F>> : Workflow<I, O, ErrorOf<F>> & { readonly run: Rule<I, O, ErrorOf<F>> });
type Connect<C, P extends readonly Stage[], O, Operation extends string> = {
  readonly [K in keyof P]: DiagnosticRule<P[K], Inputs<C, P>[K & keyof Inputs<C, P>], K extends keyof Tail<P> ? Outputs<C, P>[K & keyof Outputs<C, P>] : O, Operation, K>
};
type Checked<L extends Load, E extends Entry, O, Operation extends string> = E extends Pipeline ? Connect<Loaded<Loader<L, E>>, E, O, Operation> : E extends { load: infer A extends Load; run: infer P extends Pipeline }
  ? { readonly load: A; readonly run: Connect<Loaded<Loader<L, E>>, P, O, Operation> } : never;
type Requests<L extends Load, T extends Record<string, Entry>> = { [K in keyof T]: Input<Loader<L, T[K]>> }[keyof T];
type ReplayValue<S> = S extends Execution<infer O> ? O : never;
type ObservedDetailed<I, R> = {
  (input: I): Promise<R>;
  <A, B>(input: I, capture: WorkflowCapture<A, B>): Promise<R & ObservationReport<A, B>>;
};
type Callable<C> = C extends { run: infer R extends (...args: never[]) => unknown; runDetailed(input: infer I): Promise<infer D> }
  ? R & Omit<C, 'runDetailed'> & { readonly runDetailed: ObservedDetailed<I, D> } : never;
type DecisionOutput<L extends Load, E extends Entry> = Outputs<Loaded<Loader<L, E>>, Stages<E>> extends readonly [...unknown[], infer O] ? O : never;
// Refine only when the actual save function accepts this decision and promises the
// narrower output. A monomorphic broad save must keep its declared result type.
type DirectCandidate<O, S> = O extends S ? O : O extends object ? Extract<O[keyof O], S> : never;
type Member<O, S> = [Extract<O, S>] extends [never] ? S : Extract<O, S>;
type Shape<O, S> = { [K in keyof S]: K extends keyof O ? Member<O[K], S[K]> : S[K] };
type ShapeCandidate<O, S> = O extends object ? S extends object ? Shape<O, S> extends S ? Shape<O, S> : never : never : never;
type ShapeSaved<D, O, S, SE, C> = [ShapeCandidate<O, S>] extends [never] ? S
  : D extends { save: (value: O, context: C) => Promise<Result<ShapeCandidate<O, S>, SE>> } ? ShapeCandidate<O, S> : S;
type Saved<D, O, S, SE, C> = [DirectCandidate<O, S>] extends [never] ? ShapeSaved<D, O, S, SE, C>
  : D extends { save: (value: O, context: C) => Promise<Result<DirectCandidate<O, S>, SE>> } ? DirectCandidate<O, S> : ShapeSaved<D, O, S, SE, C>;
type Commands<L extends Load, T extends Record<string, Entry>, S, SE, RE, D extends object> = {
  readonly [K in keyof T]: Callable<SelectCommand<D,
    PlainCommand<Input<Loader<L, T[K]>>, Saved<D, DecisionOutput<L, T[K]>, S, SE, GroupExecution<OperationNames<T>, Requests<L, T>>>, LoadError<Loader<L, T[K]>> | ErrorOf<Stages<T[K]>[number]> | SE>,
    ReplayCommand<Input<Loader<L, T[K]>>, S, LoadError<Loader<L, T[K]>> | ErrorOf<Stages<T[K]>[number]> | SE, RE>
  >>
};
interface RuntimeDefinition {
  name: string;
  operation?: (name: string) => string;
  load?: ActionLoad<unknown, unknown, unknown>;
  save: (value: unknown, context: GroupExecution<string, unknown>) => Promise<Result<unknown, unknown>>;
  operations: Record<string, readonly (Rule<unknown, unknown, unknown> | Step<unknown, unknown, unknown> | Workflow<unknown, unknown, unknown>)[] | { load: ActionLoad<unknown, unknown, unknown>; run: readonly (Rule<unknown, unknown, unknown> | Step<unknown, unknown, unknown> | Workflow<unknown, unknown, unknown>)[] }>;
  replay?: { lookup: (context: GroupExecution<string, unknown>) => Result<Receipt<unknown>, unknown> | Promise<Result<Receipt<unknown>, unknown>>; resolveAfter: readonly string[] | ((error: unknown) => boolean) };
}
type SaveFn = (...args: never[]) => Promise<Result<unknown, unknown>>;
type SaveInput<A> = Parameters<Extract<A, SaveFn>>[0];
type SaveResult<A> = Awaited<ReturnType<Extract<A, SaveFn>>>;
/** Operations are own data entries of a plain record. Numeric names use JavaScript
 * string keys; Symbols, accessors and custom-prototype operation tables are rejected.
 * Stages may be plain rules, named Step objects or explicit Workflows; names and rule references are
 * captured at construction. Callable objects with a rule property are ambiguous.
 */
export function business<L extends Load, O, S extends Execution<unknown>, SE, RE, const T extends Record<string, Entry>, const D extends object>(definition: D & {
  name: string;
  operation?: (name: OperationNames<T>) => string;
  load?: L;
  save: (value: O, context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Promise<Result<S, SE>>;
  // Infer the user tuple first; the compatibility check must not widen it.
  operations: T & NoInfer<{ readonly [K in keyof T]: K extends string | number ? K extends 'then' ? never : Checked<L, T[K], O, OperationName<K>> : never }>;
  replay: {
    lookup: (context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Result<Receipt<ReplayValue<S>>, RE> | Promise<Result<Receipt<ReplayValue<S>>, RE>>;
    resolveAfter: readonly string[] | ((error: unknown) => boolean);
  };
} & NoInfer<SharedLoad<L, T>>): Commands<L, T, S, SE, RE, D & { replay: object }>;
export function business<L extends Load, O, S, SE, RE, const T extends Record<string, Entry>, const D extends object>(definition: D & {
  name: string;
  operation?: (name: OperationNames<T>) => string;
  load?: L;
  save: (value: O, context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Promise<Result<S, SE>>;
  // Infer the user tuple first; the compatibility check must not widen it.
  operations: T & NoInfer<{ readonly [K in keyof T]: K extends string | number ? K extends 'then' ? never : Checked<L, T[K], O, OperationName<K>> : never }>;
  replay?: {
    lookup: (context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Result<Receipt<ReplayValue<S>>, RE> | Promise<Result<Receipt<ReplayValue<S>>, RE>>;
    resolveAfter: readonly string[] | ((error: unknown) => boolean);
  } & ReplaySaveCheck<NoInfer<S>>;
} & NoInfer<SharedLoad<L, T>>): Commands<L, T, S, SE, RE, D>;
/** Infer an ordinary or generic save before checking its shared boundary contract. */
export function business<L extends Load, const A extends object, RE, const T extends Record<string, Entry>, const D extends object>(definition: D & {
  name: string;
  operation?: (name: OperationNames<T>) => string;
  load?: L;
  save: A & NoInfer<A extends (value: SaveInput<A>, context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Promise<Result<unknown, unknown>> ? unknown : never>;
  operations: T & NoInfer<{ readonly [K in keyof T]: K extends string | number ? K extends 'then' ? never : Checked<L, T[K], SaveInput<A>, OperationName<K>> : never }>;
  replay?: {
    lookup: (context: GroupExecution<OperationNames<T>, Requests<L, T>>) => Result<Receipt<ReplayValue<Value<SaveResult<A>>>>, RE> | Promise<Result<Receipt<ReplayValue<Value<SaveResult<A>>>>, RE>>;
    resolveAfter: readonly string[] | ((error: unknown) => boolean);
  } & ReplaySaveCheck<Value<SaveResult<A>>>;
} & NoInfer<SharedLoad<L, T>>): Commands<L, T, Value<SaveResult<A>>, Failure<SaveResult<A>>, RE, D>;
export function business(definition: object) {
  // Public checks prove adjacency. Only heterogeneous tuple positions are erased here.
  const source = definition as unknown as RuntimeDefinition;
  // TypeScript cannot describe property ownership, enumerability or accessors.
  // Capture data descriptors once, and never silently omit a declared own key.
  const table = source.operations;
  if (!isPlainRecord(table)) throw new TypeError('BusinessOperationsRequirePlainRecord');
  const descriptors = Object.getOwnPropertyDescriptors(table);
  const entries: [string, RuntimeDefinition['operations'][string]][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor;
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) throw new TypeError('BusinessOperationsRequireStringDataKeys');
    if (key === 'then') throw new Error('ReservedBusinessOperation:then');
    entries.push([key, descriptor.value]);
  }
  const needsSharedLoad = entries.some(([, entry]) => !('run' in entry));
  const sharedLoad = needsSharedLoad ? source.load : undefined;
  if (needsSharedLoad && sharedLoad === undefined) throw new TypeError('BusinessRequiresSharedLoad');
  const resolveOperation = source.operation ?? ((name: string) => `${source.name}.${name}`);
  const ids = new Map<string, string>();
  const save = source.save;
  const replay = source.replay ? { lookup: source.replay.lookup, resolveAfter: Array.isArray(source.replay.resolveAfter)
    ? [...source.replay.resolveAfter] : source.replay.resolveAfter } : undefined;
  const config = { operation: (name: string) => {
    if (!ids.has(name)) ids.set(name, resolveOperation(name));
    return ids.get(name)!;
  }, save };
  const runtime = (observe?: StageObserver) => {
    let lookups = 0;
    const observedSave = observe ? (value: unknown, context: GroupExecution<string, unknown>) =>
      observeEffect(context.operation, value, () => save(value, context), observe) : save;
    return replay ? createGroupRuntime({ ...config,
      save: observedSave as (value: unknown, context: GroupExecution<string, unknown>) => Promise<Result<Execution<unknown>, unknown>>,
      replay: { ...replay, lookup: observe ? (context: GroupExecution<string, unknown>) =>
        observeEffect(`${context.operation}:lookup:${++lookups}`, context.request, () => replay.lookup(context), observe) : replay.lookup },
    }) : createGroupRuntime({ ...config, save: observedSave });
  };
  const group = runtime();
  const commands: Record<string, unknown> = {};
  for (const [name, entry] of entries) {
    const custom = 'run' in entry;
    const rules = [...(custom ? entry.run : entry)].map((stage, index) => {
      if (typeof stage === 'function') {
        // A callable structural Step can hide a different outer function when
        // assigned to Step alone. Never silently choose one of two rule bodies.
        if ('rule' in stage || observeEvaluation in stage) throw new TypeError('AmbiguousBusinessStage');
        return workflow(`run:${index + 1}`, stage);
      }
      if (stage === null || typeof stage !== 'object') throw new TypeError('BusinessRequiresRule');
      if (stage instanceof Workflow) {
        if ('rule' in stage) throw new TypeError('AmbiguousBusinessStage');
        const observed = stage[observeEvaluation];
        return registerStructure(new Workflow(stage.name, [...stage.steps], (input: unknown, observe) =>
          observed(input, observe)), structureOf(stage));
      }
      const { name, rule } = stage;
      if (typeof name !== 'string' || typeof rule !== 'function') throw new TypeError('BusinessRequiresRule');
      return workflow(name, rule);
    });
    if (!rules.length) throw new Error('BusinessRequiresRule');
    const selectedLoad = custom ? entry.load : sharedLoad;
    if (selectedLoad === undefined) throw new TypeError('BusinessRequiresLoad');
    const load = captureLoad(selectedLoad);
    const decide = (capture?: StageObserver) => registerStructure(new Workflow<unknown, unknown, unknown>(name, rules.flatMap(flow => flow.steps), (input, live) => {
      // Selected capture and live instrumentation observe the same explicit inner
      // stages. Keep the existing outer-before-inner input / reverse-result order.
      let observe = capture ?? live;
      if (capture && live) {
        observe = Object.assign((step: string, value: unknown): StageReceiver => {
          const outer = live(step, value), inner = capture(step, value);
          return Object.assign((result: Result<unknown, unknown>) => { inner(result); outer(result); },
            { defect: () => { inner.defect?.(); outer.defect?.(); } });
        }, { live: live.live, scope: live.scope });
      }
      let value = input;
      const trace: Evaluation<unknown, unknown>['trace'][number][] = [];
      for (const flow of rules) {
        const next = flow[observeEvaluation](value, observe);
        trace.push(...next.trace);
        if (!next.result.ok) return { result: next.result, trace };
        value = next.result.value;
      }
      return { result: { ok: true, value }, trace };
    }), structureSequence(...rules.map(flow => structureOf(flow))));
    const command = group.on(name, { load, decide: decide() });
    const runDetailed = async <A, B>(input: unknown, capture?: WorkflowCapture<A, B>) => {
      if (!capture) return command.runDetailed(input);
      const recorder = createObservation(capture), id = config.operation(name);
      const observed = runtime(recorder.observe).on(name, {
        load: typeof load === 'function'
          ? (request: unknown) => observeEffect(`${id}:load`, request, () => load(request), recorder.observe)
          : { runDetailed: async (request: unknown) => {
            const receive = recorder.observe(`${id}:load`, request);
            const detail = await load.runDetailed(request);
            receive(detail.result);
            return detail;
          } },
        decide: decide(recorder.observe),
      });
      const report = await observed.runDetailed(input);
      return { ...report, ...recorder.report() };
    };
    inheritDetailed(runDetailed, command.runDetailed);
    const run = (input: unknown) => command.run(input);
    // Works both as expense.approve(input) and as a command for operations(...).
    Object.defineProperty(commands, name, { value: registerStructure(Object.freeze(Object.assign(run, command, { runDetailed })), structureOf(command)), enumerable: true });
  }
  return Object.freeze(commands);
}
