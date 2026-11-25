import { workflow, process, ok, type Result } from 'koyuki';
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
