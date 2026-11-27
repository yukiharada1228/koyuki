/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, defineOperation, createContext, useContext, createApplication, Operation, operationKey, useOperation } from './framework/authoring.js';
import { workflow, ok, err, type Result, type Execution, type ExecutionEvent, type ReplayInputError, type StepObservation } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Request = { id: string };
const Owner = createContext<string>();
test('one declaration supplies the name, Provider-bound Hook, JSX registration and inferred execution contract', async () => {
  let declarations = 0, loads = 0, saves = 0;
  const decide = workflow('check', (input: { id: string; owner: string }): Result<{ by: string }, 'Denied'> =>
    input.id === 'denied' ? err('Denied') : ok({ by: input.owner }));
  const approval = defineOperation('approve.v1', () => {
    declarations++;
    const owner = useContext(Owner);
    return {
      load: async (input: Request): Promise<Result<{ id: string; owner: string }, 'LoadFailed'>> => { loads++; return ok({ ...input, owner }); },
      execute: decide,
      save: async value => { saves++; return ok(value); },
    };
  });
  assert.equal(declarations, 0);
  assert.throws(() => approval.use(), /HooksRequireComponentEvaluation/);
  assert.equal(declarations, 0);
  const events: ExecutionEvent[] = [];
  const app = createApplication(<Owner.Provider value="boss"><Operation operation={approval} /></Owner.Provider>, { observeExecution: event => events.push(event) });
  assert.equal(declarations, 1); assert.equal(loads, 0); assert.equal(saves, 0);
  const report = await app.executeDetailed(approval, { id: 'one' }, { input: (_value, step) => ({ step }), result: result => result.ok });
  const exactResult: Equal<typeof report.result, Result<{ by: string }, 'LoadFailed' | 'Denied'>> = true;
  const exactCapture: Equal<typeof report.observations, readonly StepObservation<{ step: string }, boolean>[]> = true;
  void exactResult; void exactCapture;
  assert.deepEqual(report.result, ok({ by: 'boss' }));
  assert.deepEqual(report.trace.map(row => row.step), ['approve.v1:load', 'check', 'approve.v1']);
  assert.equal(saves, 1); assert.equal(loads, 1); assert.equal(declarations, 1);
  assert(events.some(event => event.kind === 'span-started' && event.step === 'check'));
  assert.deepEqual(await app.execute(approval, { id: 'denied' }), err('Denied'));
  assert.equal(saves, 1);
  assert.equal(app.execute, app.dispatch); assert.equal(app.executeDetailed, app.inspect);
  if (false) {
    // @ts-expect-error The request must survive declaration inference.
    void app.execute(approval, {});
    // @ts-expect-error Detailed execution must retain the same input contract.
    void app.executeDetailed(approval, { id: 1 });
    const bare = operationKey<Request, string, never>('bare');
    // @ts-expect-error A legacy key without a definition still needs a handler.
    void <Operation operation={bare} />;
  }
});
test('the same declaration captures separate Providers and separate concurrent executions', async () => {
  const approval = defineOperation('approve.v1', () => {
    const owner = useContext(Owner);
    return { load: async (input: Request) => ok({ input, owner }), execute: workflow('owner', (value: { input: Request; owner: string }) => ok(value.owner)), save: async value => ok(value) };
  });
  const a = createApplication(<Owner.Provider value="a"><Operation operation={approval} /></Owner.Provider>);
  const b = createApplication(<Owner.Provider value="b"><Operation operation={approval} /></Owner.Provider>);
  assert.deepEqual(await Promise.all([a.execute(approval, { id: 'one' }), b.execute(approval, { id: 'two' })]), [ok('a'), ok('b')]);
  assert.throws(() => createApplication(<Owner.Provider value="a"><Operation operation={approval} /><Operation operation={approval} /></Owner.Provider>), /DuplicateOperation:approve.v1/);
  assert.throws(() => createApplication(<Operation operation={approval} />), /MissingContextProvider/);
  assert.deepEqual(await b.execute(approval, { id: 'three' }), ok('b'));
});
test('declared replay retains its envelope, skips cached business work and exposes its detailed attempt', async () => {
  let saved: string | undefined, commits = 0;
  const approval = defineOperation('replayed.v1', () => ({
    load: async (input: Request) => ok(input.id),
    execute: workflow('approve', (id: string) => ok(id.toUpperCase())),
    save: async (value): Promise<Result<Execution<string>, 'SaveConflict'>> => { saved = value; commits++; return ok({ kind: 'committed', value }); },
    replay: { lookup: (_input: Request) => ok(saved === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, value: saved }), resolveAfter: error => error === 'SaveConflict' },
  }));
  const app = createApplication(<Operation operation={approval} />);
  const first = await app.executeDetailed(approval, { id: 'one' });
  const exact: Equal<typeof first.result, Result<Execution<string>, 'SaveConflict' | ReplayInputError>> = true; void exact;
  assert.deepEqual(first.result, ok({ kind: 'committed', value: 'ONE' }));
  assert(first.attempt?.trace?.some(row => row.step === 'approve'));
  const repeated = await app.executeDetailed(approval, { id: 'one' });
  assert.deepEqual(repeated.result, ok({ kind: 'replayed', value: 'ONE' }));
  assert.equal(repeated.attempt, null); assert.equal(commits, 1);
});
test('legacy custom Hooks and JSX handlers still register with the new execution names', async () => {
  function useLegacy() { return useOperation({ name: 'legacy', load: async (input: Request) => ok(input.id), execute: (id: string) => ok(id), save: async value => ok(value) }); }
  const key = operationKey('legacy', useLegacy);
  function Legacy() { const handler = useLegacy(); return <Operation operation={key} handler={handler} />; }
  const app = createApplication(<Legacy />);
  assert.deepEqual(await app.execute(key, { id: 'one' }), ok('one'));
});
