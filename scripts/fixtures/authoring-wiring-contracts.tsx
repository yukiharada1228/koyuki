/** @jsx h */
import { ok, err, type Result } from 'koyuki';
import { h, Fragment, createApplication, defineResource, defineOperation, defineEvent, emit, Operation, On } from 'koyuki/experimental';
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
