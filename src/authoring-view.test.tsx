/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result } from './framework/index.js';
import { h, Fragment, createApplication, createContext, useContext, defineResource, defineOperation, defineEvent, emit, Operation, On, projection, defineView } from './framework/authoring.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function setup() {
  const Owner = createContext<string>();
  const owner = defineResource('owner', () => { const value = useContext(Owner); return () => ok(value); });
  const request = defineResource('request', () => (input: { amount: number }) => ok(input));
  let writes = 0, deliveries = 0;
  let release: (() => void) | undefined;
  const changed = defineEvent<number>('changed');
  const add = defineOperation('add', {
    needs: { owner, request },
    execute: ({ owner, request }: { owner: string; request: { amount: number } }): Result<{ owner: string; amount: number }, 'Negative'> => request.amount < 0 ? err('Negative') : ok({ owner, amount: request.amount }),
    useSave: () => async (value: { owner: string; amount: number }): Promise<Result<typeof value, 'Offline'>> => {
      if (value.amount === 7) await new Promise<void>(resolve => { release = resolve; });
      if (value.amount === 9) throw new Error('storage defect');
      if (value.amount === 8) return err('Offline');
      writes++; return ok(value);
    }, emits: [emit(changed, (value: { owner: string; amount: number }) => value.amount)],
  });
  const payload = defineResource('payload', () => (value: number) => ok(value));
  const notify = defineOperation('notify', { needs: { payload }, execute: ({ payload }: { payload: number }) => ok(payload), useSave: () => async (_value: number) => { deliveries++; return err('MailUnavailable' as const); } });
  const app = (owner: string) => createApplication(<Owner.Provider value={owner}><Fragment><Operation operation={add} /><On event={changed} operation={notify} /></Fragment></Owner.Provider>);
  type Data = { total: number; owner: string };
  const definition = defineView({
    initial: (): Data => ({ total: 0, owner: '' }),
    operations: { add: projection(add, (state: Data, output) => ({ total: state.total + output.amount, owner: output.owner })) },
    view: state => ({ total: state.data.total, owner: state.data.owner, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error : state.kind === 'crashed' ? state.error.kind : null }),
  });
  return { app, definition, add, get writes() { return writes; }, get deliveries() { return deliveries; }, release: () => release!() };
}
test('a JSX application starts a typed lifecycle and view over its mounted operations, including event delivery', async () => {
  const f = setup(), app = f.app('alice');
  // Inline view needs no explicit lifecycle annotation.
  const session = await app.start({ ...f.definition, view: state => ({ total: state.data.total, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error : null }) });
  const states: string[] = [], delivered: string[] = [], spans: string[] = [];
  const unsubscribe = session.subscribe(snapshot => { states.push(snapshot.state.kind); snapshot.state.data.total = -100; });
  session.subscribeDelivery(event => { delivered.push(event.status); });
  session.subscribeExecution(event => { if (event.kind === 'span-started') spans.push(event.step); });
  assert.deepEqual(session.snapshot().view, { total: 0, busy: false, error: null });
  const pending = session.dispatch({ type: 'add', input: { amount: 7 } });
  for (let n = 0; n < 100 && session.snapshot().state.kind !== 'running'; n++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(session.snapshot().view.busy, true); assert.equal(f.writes, 0);
  // The save may not have been reached when the running projection publishes.
  await new Promise(resolve => setTimeout(resolve, 0)); f.release();
  const result = await pending; assert(result.ok);
  assert.deepEqual(session.snapshot().view, { total: 7, busy: false, error: null });
  assert.equal(f.writes, 1); assert.equal(f.deliveries, 1); assert.deepEqual(delivered, ['error']);
  assert.deepEqual(states, ['ready', 'running', 'ready']); assert(spans.includes('resource:owner'));
  const failed = await session.dispatch({ type: 'add', input: { amount: -1 } }); assert(failed.ok);
  const state = session.snapshot().state;
  assert.equal(state.kind, 'failed');
  if (state.kind === 'failed') { const exact: Equal<typeof state.error, 'Negative' | 'Offline'> = true; assert(exact); }
  assert.equal(session.snapshot().state.data.total, 7);
  assert.deepEqual(await session.dispatch({ type: 'add', input: { amount: 1 } }), err({ kind: 'UnexpectedMessage' }));
  await session.dispatch({ type: 'dismiss' });
  await session.dispatch({ type: 'add', input: { amount: 9 } });
  assert.equal(session.snapshot().state.kind, 'crashed'); assert.equal(session.snapshot().state.data.total, 7);
  await session.dispatch({ type: 'dismiss' });
  assert.deepEqual(await session.dispatch({ type: 'add', input: { amount: 2 } }, 0), err({ kind: 'StaleRevision' }));
  assert.equal(f.writes, 1); unsubscribe();
  if (false) {
    // @ts-expect-error Typed operation input remains intact.
    void session.dispatch({ type: 'add', input: { amount: 'one' } });
    // @ts-expect-error Private completion messages cannot be forged.
    void session.dispatch({ type: '@complete', operation: 'add', result: ok(1) });
    // @ts-expect-error Projection must accept the operation's actual success value.
    projection(f.add, (_state: number, value: string) => value.length);
    // @ts-expect-error Plain object bindings must satisfy the same output contract.
    void app.start({ initial: () => 0, operations: { invalid: { operation: f.add, reduce: (_state: number, output: string) => output.length } }, view: state => state.data });

  }
});
test('sessions isolate presentation state and retain Provider scope while serializing each own dispatch queue', async () => {
  const f = setup(), a = f.app('alice'), b = f.app('bob');
  const [left, right, other] = await Promise.all([a.start(f.definition), a.start(f.definition), b.start(f.definition)]);
  await Promise.all([left.dispatch({ type: 'add', input: { amount: 1 } }), left.dispatch({ type: 'add', input: { amount: 2 } }), right.dispatch({ type: 'add', input: { amount: 4 } }), other.dispatch({ type: 'add', input: { amount: 5 } })]);
  assert.deepEqual(left.snapshot().state.data, { total: 3, owner: 'alice' });
  assert.deepEqual(right.snapshot().state.data, { total: 4, owner: 'alice' });
  assert.deepEqual(other.snapshot().state.data, { total: 5, owner: 'bob' });
  assert.equal(f.writes, 4); assert.equal(f.deliveries, 4);
});
test('view bindings reject missing or duplicate operations before initial/view and cannot write by starting', async () => {
  const f = setup(), empty = createApplication(<Fragment>{[]}</Fragment>); let initialized = 0;
  const definition = { ...f.definition, initial: () => { initialized++; return { total: 0, owner: '' }; } };
  await assert.rejects(empty.start(definition), /UnregisteredOperation:add/); assert.equal(initialized, 0);
  await assert.rejects(f.app('alice').start({ ...definition, operations: { a: f.definition.operations.add, b: f.definition.operations.add }, view: state => state.data }), /DuplicateProjection:add/); assert.equal(initialized, 0);
  await f.app('alice').start(definition); assert.equal(initialized, 1); assert.equal(f.writes, 0);
});
