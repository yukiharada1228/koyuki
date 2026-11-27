/** @jsx h */
import { h, defineOperation, Operation, createApplication } from 'koyuki/experimental';
import * as authoring from 'koyuki/experimental';
import { workflow, ok, type Result, type Execution, type ReplayInputError, type ReplayReport, type StepObservation } from 'koyuki';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const noLegacyExports: Equal<Extract<keyof typeof authoring, 'useOperation' | 'operationKey' | 'replayOperationKey'>, never> = true; void noLegacyExports;
type Request = { id: string };
type Authorized = { id: string; authorized: true };
const load = async (input: Request): Promise<Result<string, 'LoadFailed'>> => ok(input.id);
const decide = workflow('approve', (value: string): Result<number, 'Denied'> => ok(value.length));
const save = async (value: number): Promise<Result<{ count: number }, 'SaveFailed'>> => ok({ count: value });
const approval = defineOperation('approval', () => ({ load, execute: decide, save }));
const app = createApplication(<Operation operation={approval} />);
const result = app.execute(approval, { id: 'one' });
const exact: Equal<typeof result, Promise<Result<{ count: number }, 'LoadFailed' | 'Denied' | 'SaveFailed'>>> = true; void exact;
const captured = app.executeDetailed(approval, { id: 'one' }, { input: (_value, step) => ({ step }), result: result => result.ok });
const exactCapture: Equal<Awaited<typeof captured>['observations'], readonly StepObservation<{ step: string }, boolean>[]> = true; void exactCapture;
const replay = defineOperation('replayed', () => ({ load, execute: decide,
  save: async (value): Promise<Result<Execution<number>, 'SaveConflict'>> => ok({ kind: 'committed', value }),
  replay: { lookup: (_input: Request): Result<{ kind: 'missing' }, 'LookupFailed'> => ok({ kind: 'missing' }), resolveAfter: error => error === 'SaveConflict' },
}));
const replayApp = createApplication(<Operation operation={replay} />);
const report = replayApp.executeDetailed(replay, { id: 'one' });
const exactReplay: Equal<typeof report, Promise<ReplayReport<number, 'LoadFailed' | 'Denied' | 'SaveConflict', 'LookupFailed'>>> = true; void exactReplay;
const exactReplayResult: Equal<Awaited<typeof report>['result'], Result<Execution<number>, 'LoadFailed' | 'Denied' | 'SaveConflict' | 'LookupFailed' | ReplayInputError>> = true; void exactReplayResult;
if (false) {
  // @ts-expect-error There is one execution name, without a legacy alias.
  void app.dispatch(approval, { id: 'one' });
  // @ts-expect-error Detailed execution is an explicit execution API.
  void app.inspect(approval, { id: 'one' });
  // @ts-expect-error Registration no longer accepts a separate manual handler.
  void <Operation operation={approval} handler={approval.use()} />;
  // @ts-expect-error Required input remains required.
  void app.execute(approval, {});
  // @ts-expect-error Capture cannot widen the required request.
  void app.executeDetailed(approval, {}, { input: () => null, result: () => true });
  // @ts-expect-error Bare legacy keys have no Hook to register automatically.
  void <Operation operation={{ name: 'bare' }} />;
  // @ts-expect-error The definition cannot silently rename its operation.
  defineOperation('one-name', () => ({ name: 'second-name', load, execute: decide, save }));
  // @ts-expect-error A Promise-returning component definition is not a synchronous Hook.
  defineOperation('async-hook', async () => ({ load, execute: decide, save }));
  // @ts-expect-error A stage expecting number cannot consume a loaded string.
  defineOperation('bad-input', () => ({ load, execute: (input: number) => ok(input), save }));
  // @ts-expect-error Saving string is incompatible with a numeric domain output.
  defineOperation('bad-save', () => ({ load, execute: decide, save: async (input: string) => ok(input) }));
  // @ts-expect-error Replay requires save to supply an atomic Execution envelope.
  defineOperation('bad-replay', () => ({ load, execute: decide, save, replay: { lookup: (_input: Request) => ok({ kind: 'missing' as const }), resolveAfter: () => false } }));
  // @ts-expect-error A missing authorization fact cannot be supplied by output inference.
  defineOperation('skip-authorization', () => ({ load: async (input: Request) => ok(input), execute: (input: Authorized) => ok(input.id), save: async (value: string) => ok(value) }));
}
