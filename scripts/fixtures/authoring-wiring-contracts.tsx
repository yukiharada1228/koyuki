/** @jsx h */
import { ok, err, type Result } from 'koyuki';
import { h, Fragment, createApplication, defineResource, defineOperation, defineEvent, emit, Operation, On, defineView, projection } from 'koyuki/experimental';
const current = defineResource('current', () => async (input: { id: string }): Promise<Result<number, 'Missing'>> => input.id ? ok(1) : err('Missing'));
const actor = defineResource('actor', () => () => ok('host'));
const changed = defineEvent<number>('changed');
export const producer = defineOperation('producer', {
  needs: { current, actor }, execute: (values: { current: number; actor: string }) => ok(values.current),
  useSave: () => async (value: number): Promise<Result<number, 'Offline'>> => ok(value), emits: [emit(changed)],
});
const payload = defineResource('payload', () => (value: number) => ok(value));
const receiver = defineOperation('receiver', { needs: { payload }, execute: ({ payload }: { payload: number }) => ok(payload), useSave: () => async (value: number) => ok(value) });
export const app = createApplication(<Fragment><Operation operation={producer} /><On event={changed} operation={receiver} /></Fragment>);
const report = await app.executeDetailed(producer, { id: 'one' });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<typeof report.result, Result<number, 'Missing' | 'Offline'>> = true; void exact;
const id: string | undefined = report.publications[0]?.id; void id;
if (false) {
  // @ts-expect-error Every resource input must be satisfied.
  void app.execute(producer, {});
  // @ts-expect-error Host actor is not caller input.
  void app.execute(producer, { id: 'one', actor: 'admin' });
  // @ts-expect-error Consumer input must accept the event payload.
  void <On event={defineEvent<string>('string')} operation={receiver} />;
  // @ts-expect-error Resource values must satisfy business requirements.
  defineOperation('bad-context', { needs: { current }, execute: (values: { current: string }) => ok(values), useSave: () => async (value: { current: string }) => ok(value) });
  // @ts-expect-error Saved value must accept the decision's success value.
  defineOperation('bad-save', { needs: { current }, execute: (values: { current: number }) => ok(values.current), useSave: () => async (value: string) => ok(value) });
}

export const screen = defineView({
  initial: () => 0,
  operations: { change: projection(producer, (_state: number, output) => output) },
  view: state => ({ value: state.data, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error : null }),
});
export const session = await app.start(screen);
const snapshot = session.snapshot();
const exactError: Equal<typeof snapshot.view.error, 'Missing' | 'Offline' | null> = true; void exactError;
if (false) {
  // @ts-expect-error Session events retain the underlying operation input.
  void session.dispatch({ type: 'change', input: {} });
  // @ts-expect-error Projection cannot consume a different success type.
  projection(producer, (_state: number, value: string) => value.length);
}

if (false) {
  // @ts-expect-error Handwritten bindings must also accept the true success type.
  void app.start({ initial: () => 0, operations: { bad: { operation: producer, reduce: (_state: number, value: string) => value.length } }, view: state => state.data });
}
