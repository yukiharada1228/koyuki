import { workflow, process, defineCommand, bindMutation, operation, replayOperation, defineUseCase, step, ok, type Result } from 'koyuki';
type Ready = { readonly kind: 'ready'; readonly id: string };
type Absent = { readonly kind: 'absent'; readonly newId: string };
type State = Ready | Absent;
const guard = (value: State): value is Ready => value.kind === 'ready';
const update = workflow('update', (value: Ready): Result<string, 'UpdateFailed'> => ok(value.id));
const create = workflow('create', (value: Absent): Result<number, 'CreateFailed'> => ok(value.newId.length));
const start = workflow('restore', (value: State): Result<State, 'Corrupt'> => ok(value));
const flow = start.branch('ready', guard, { yes: update, no: create });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<ReturnType<typeof flow.run>, Result<string | number, 'Corrupt' | 'UpdateFailed' | 'CreateFailed'>> = true;
void exact;
const inline = start.branch('inline', (value: State): value is Ready => value.kind === 'ready', { yes: update, no: create });
void inline;
// @ts-expect-error branches cannot be swapped
start.branch('swapped', guard, { yes: create, no: update });
// @ts-expect-error a boolean function proves no narrowed input
start.branch('boolean', (_value: State): boolean => true, { yes: update, no: create });
// @ts-expect-error an unproved literal constraint cannot be required by a branch
start.branch('literal', guard, { yes: workflow('strict', (value: Ready & { id: 'one' }) => ok(value.id)), no: create });

// @ts-expect-error a Process Union output cannot be sent directly to a single-variant workflow
process<State>().through(update);

const onlyOne = workflow('one', (value: 'one') => ok(value.length));
// @ts-expect-error the loader returns strings which have not been proved to be the one literal
defineCommand({ operation: 'unsafe', load: async (_id: number) => ok('any' as string), decide: onlyOne, save: async (value: number) => ok(value) });

// @ts-expect-error an explicit wider mutation input does not prove the workflow's literal requirement
bindMutation<string, number, never, number, never>({ operation: 'unsafe-binding', workflow: onlyOne, save: async value => ok(value) });

// @ts-expect-error a Workflow alias must not widen its accepted input and bypass connection checks
const widened: import('koyuki').Workflow<string, number, never> = onlyOne;
void widened;

const plainNarrow = { run: async (input: 'one') => ok(input.length) };
// @ts-expect-error an explicitly wider Application operation cannot consume a literal-only command
operation<number, string, number, never>(plainNarrow, (state, value) => state + value);
const replayNarrow = { run: async (input: 'one') => ok({ kind: 'committed' as const, value: input.length }) };
// @ts-expect-error an explicitly wider replay operation cannot consume a literal-only command
replayOperation<number, string, number, never>(replayNarrow, (state, value) => state + value);

function makeCommand<I extends string>() {
  return defineUseCase({ operation: 'alias.v1', load: async (input: I) => ok(input),
    transition: { validate: step('validate', (value: I) => ok(value)), require: [] as const, evolve: step('length', (value: I) => ok(value.length)) },
    save: async (value: number) => ok(value) });
}
const narrowCommand = makeCommand<'one'>();
const wideCommand = makeCommand<string>();
// @ts-expect-error public command return types must not allow input widening through assignment
const widenedCommand: typeof wideCommand = narrowCommand;
void widenedCommand;

function makeReplayCommand<I extends string>() {
  return defineUseCase({ operation: 'alias-replay.v1', load: async (input: I) => ok(input),
    transition: { validate: step('validate', (value: I) => ok(value)), require: [] as const, evolve: step('length', (value: I) => ok(value.length)) },
    save: async (value: number) => ok({ kind: 'committed' as const, value }),
    replay: { lookup: async (_input: I) => ok({ kind: 'missing' as const }), resolveAfter: (_error: never) => false } });
}
const narrowReplayCommand = makeReplayCommand<'one'>();
const wideReplayCommand = makeReplayCommand<string>();
// @ts-expect-error replay command aliases cannot widen input either
const widenedReplayCommand: typeof wideReplayCommand = narrowReplayCommand;
void widenedReplayCommand;

// Safe variance directions must remain usable; these also rule out unrelated type mismatches.
const restrictedWorkflow: import('koyuki').Workflow<'one', number, never> = workflow('wide', (value: string) => ok(value.length));
const restrictedCommand: typeof narrowCommand = wideCommand;
const restrictedReplayCommand: typeof narrowReplayCommand = wideReplayCommand;
operation<number, 'one', number, never>({ run: async (value: string) => ok(value.length) }, (state, value) => state + value);
replayOperation<number, 'one', number, never>({ run: async (value: string) => ok({ kind: 'committed' as const, value: value.length }) }, (state, value) => state + value);
void restrictedWorkflow; void restrictedCommand; void restrictedReplayCommand;
