import { business, ok, err, type Result, type Execution, type Receipt, type GroupExecution } from 'koyuki';
type Actor = Readonly<{ id: string; active: boolean }>;
type Base = Readonly<{ id: string }>;
export type Submit = Base & Readonly<{ approver: string }>;
export type LoadFailure = Readonly<{ kind: 'LoadFailed' }>;
type Context<I> = Readonly<{ input: I; actor: Actor }>;
const checked: unique symbol = Symbol('checked');
type Checked = Readonly<{ [checked]: true }>;
const actor: Actor = { id: 'boss', active: true };
const validate = <T extends { readonly actor: Actor }>(value: T): Result<T & Checked, 'Denied'> =>
  value.actor.active ? ok({ ...value, [checked]: true }) : err('Denied');
const approve = (value: Context<Submit> & Checked): Result<string, 'Refused'> =>
  value.input.approver === value.actor.id ? ok(value.input.id) : err('Refused');
function loader<E>(unavailable: E) {
  return async <I extends Base>(input: I): Promise<Result<Context<I>, E>> =>
    input.id === 'missing' ? err(unavailable) : ok({ input, actor });
}
const save = async <T extends string>(value: T): Promise<Result<T, 'SaveFailed'>> => ok(value);
const saveExecution = async (value: string): Promise<Result<Execution<string>, 'SaveFailed'>> => ok({ kind: 'committed', value });
const replay = {
  lookup: (execution: GroupExecution<'approve', Submit>): Result<Receipt<string>, 'LookupFailed'> =>
    execution.request.id === 'cached' ? ok({ kind: 'found', value: 'cached' }) : ok({ kind: 'missing' }),
  resolveAfter: [],
};
// These exports deliberately have no final API annotation.
export function createPlain<E>(unavailable: E) {
  const load = loader(unavailable);
  return business({ name: 'exported-plain', load, save, operations: { approve: [validate, approve] } });
}
export function createReplayed<E>(unavailable: E) {
  const load = loader(unavailable);
  return business({ name: 'exported-replayed', load, save: saveExecution, operations: { approve: [validate, approve] }, replay });
}
export function createOptional<E>(unavailable: E, enableReplay: boolean) {
  const load = loader(unavailable);
  return business({ name: 'exported-optional', load, save: saveExecution, operations: { approve: [validate, approve] }, replay: enableReplay ? replay : undefined });
}
const failure: LoadFailure = { kind: 'LoadFailed' };
export const plain = createPlain(failure);
export const replayed = createReplayed(failure);
export const optional = createOptional(failure, false);

// Correlating an outer generic actor with the loaded context still needs an
// ordinary TypeScript instantiation expression for the reusable validator.
// It is not a final API annotation or a cast of the completed application.
export function createForActor<A extends Actor>(actor: A) {
  type Loaded<I> = Readonly<{ input: I; actor: A }>;
  type Approved = Readonly<{ id: string; actor: A }>;
  const load = async <I extends Base>(input: I): Promise<Result<Loaded<I>, LoadFailure>> =>
    ok({ input, actor });
  const approve = (value: Loaded<Submit> & Checked): Result<Approved, 'Refused'> =>
    value.input.approver === value.actor.id ? ok({ id: value.input.id, actor: value.actor }) : err('Refused');
  const save = async (value: Approved): Promise<Result<Approved, 'SaveFailed'>> => ok(value);
  return business({ name: 'exported-actor', load, save,
    operations: { approve: [validate<Loaded<Submit>>, approve] } });
}
