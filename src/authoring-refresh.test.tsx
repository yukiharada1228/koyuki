/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result } from './framework/index.js';
import { h, Fragment, createApplication, createContext, useContext, defineResource, defineOperation, defineQuery, Query, Operation, On, defineEvent, emit, defineView, projection, refreshQuery } from './framework/authoring.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const Owner = createContext<string>();
function fixture() {
  const requested = defineEvent<{ id: string }>('requested');
  const confirmed = defineEvent<{ id: string }>('confirmed', { external: true, decode: value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? ok({ id: value.id }) : err('InvalidEvent') });
  let stored = 'draft', reads = 0, writes = 0, failed = false, thrown = false;
  const input = defineResource('input', () => (input: { id: string }) => ok(input));
  const request = defineOperation('request', { needs: input, execute: (input: { id: string }) => ok(input), useSave: () => async (value: { id: string }) => { stored = 'requested'; writes++; return ok(value); }, emits: [emit(requested)] });
  const approve = defineOperation('approve', { needs: input, execute: (input: { id: string }) => ok(input), useSave: () => async (value: { id: string }) => { stored = 'confirmed'; writes++; return ok(value); }, emits: [emit(confirmed)] });
  const current = defineResource('current', () => {
    const owner = useContext(Owner);
    return async (input: { id: string }): Promise<Result<{ id: string; phase: string; owner: string }, 'ReadFailed'>> => {
      reads++; if (thrown) throw new Error('query defect'); if (failed) return err('ReadFailed');
      return ok({ id: input.id, phase: stored, owner });
    };
  });
  const query = defineQuery('query', { needs: current, select: (value: { id: string; phase: string; owner: string }) => ok(value) });
  type Data = { id: string; accepted: boolean; phase: string; owner: string };
  const screen = defineView({
    initial: (): Data => ({ id: 'one', accepted: false, phase: 'initial', owner: '' }),
    operations: { request: projection(request, (state: Data, output) => ({ ...state, id: output.id, accepted: true })) },
    queries: { current: refreshQuery(query, { input: (state: Data) => ({ id: state.id }), on: [confirmed], reduce: (state: Data, value) => ({ ...state, ...value }) }) },
    view: state => ({ ...state.data, busy: state.kind === 'running' || state.refreshing, query: state.queries.current, error: state.kind === 'failed' ? state.error : null }),
  });
  const app = (owner: string) => createApplication(<Owner.Provider value={owner}><Fragment><Operation operation={request} /><On event={requested} operation={approve} /><Query query={query} /></Fragment></Owner.Provider>);
  return { app, screen, query, request, confirmed, get reads() { return reads; }, get writes() { return writes; }, setStored(value: string) { stored = value; }, fail(value: boolean) { failed = value; }, throw(value: boolean) { thrown = value; } };
}
test('a downstream event refreshes an authorized query and publishes the latest state without a caller read', async () => {
  const f = fixture(), app = f.app('alice'), session = await app.start(f.screen);
  assert.equal(f.writes, 0); assert.equal(f.reads, 1); assert.equal(session.snapshot().view.phase, 'draft');
  const notifications: { phase: string; busy: boolean }[] = [];
  session.subscribe(snapshot => notifications.push({ phase: snapshot.view.phase, busy: snapshot.view.busy }));
  const done = await session.dispatch({ type: 'request', input: { id: 'two' } }); assert(done.ok);
  assert.equal(f.writes, 2); assert.equal(f.reads, 2);
  assert.deepEqual(session.snapshot().view, { id: 'two', accepted: true, phase: 'confirmed', owner: 'alice', busy: false, query: { kind: 'ready' }, error: null });
  assert.equal(notifications.some(row => row.busy), true); assert.equal(notifications.at(-1)?.phase, 'confirmed');
  const exact: Equal<Extract<ReturnType<typeof session.snapshot>['state']['queries']['current'], { kind: 'failed' }>['error'], 'ReadFailed'> = true; assert(exact);
  if (false) {
    // @ts-expect-error Query requires a string id.
    refreshQuery(f.query, { input: (_state: number) => ({ id: 1 }), on: [], reduce: (state: number) => state });
    // @ts-expect-error Query result is a model, not a number.
    refreshQuery(f.query, { input: (_state: number) => ({ id: 'one' }), on: [], reduce: (_state: number, value: number) => value });
    // @ts-expect-error Handwritten query declarations obey the same output contract.
    void app.start({ initial: () => 0, operations: {}, queries: { bad: { query: f.query, input: () => ({ id: 'one' }), on: [], reduce: (state: number, value: number) => state + value } }, view: state => state.data });

  }
});
test('query errors preserve committed business results and recover without re-executing the operation', async () => {
  const f = fixture(), session = await f.app('alice').start(f.screen);
  f.fail(true);
  const done = await session.dispatch({ type: 'request', input: { id: 'one' } }); assert(done.ok);
  assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().view.accepted, true);
  assert.deepEqual(session.snapshot().view.query, { kind: 'failed', error: 'ReadFailed' }); assert.equal(session.snapshot().view.phase, 'draft');
  assert.equal(f.writes, 2);
  f.fail(false); await session.refresh();
  assert.equal(session.snapshot().view.phase, 'confirmed'); assert.equal(f.writes, 2);
  f.throw(true); await session.refresh(); assert.equal(session.snapshot().view.query.kind, 'crashed'); assert.equal(f.writes, 2);
});
test('refresh uses the mounted Provider scope, owns snapshots, and rejects forged triggers before initial reads', async () => {
  const f = fixture(), left = await f.app('alice').start(f.screen), right = await f.app('bob').start(f.screen);
  assert.equal(left.snapshot().view.owner, 'alice'); assert.equal(right.snapshot().view.owner, 'bob');
  const copy = left.snapshot(); copy.state.data.owner = 'changed'; assert.equal(left.snapshot().view.owner, 'alice');
  const fake = defineEvent<{ id: string }>('confirmed', { external: true, decode: value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? ok({ id: value.id }) : err('InvalidEvent') }); const reads = f.reads;
  await assert.rejects(f.app('alice').start({ ...f.screen, queries: { current: refreshQuery(f.query, { input: () => ({ id: 'one' }), on: [fake], reduce: (state: ReturnType<typeof f.screen.initial>) => state }) } }), /UnknownRefreshEvent:confirmed/);
  assert.equal(f.reads, reads);
});

test('persisted delivery revalidates the view without a caller refresh or repeating the committed operation', async () => {
  const f = fixture(), session = await f.app('alice').start(f.screen);
  f.setStored('confirmed');
  const accepted = await session.deliver({ id: 'outbox-one', type: f.confirmed.name, payload: { id: 'one' } }); assert(accepted.ok);
  assert.equal(session.snapshot().view.phase, 'confirmed'); assert.equal(f.writes, 0); assert.equal(f.reads, 2);
  await session.deliver({ id: 'outbox-two', type: f.confirmed.name, payload: 10 });
  assert.equal(f.reads, 2); assert.equal(f.writes, 0);
});
test('independent query failures and projection defects do not suppress the remaining read models', async () => {
  let reads = 0;
  const base = defineResource('base', () => () => { reads++; return ok(3); });
  const rejected = defineQuery('rejected-read', { needs: base, select: (_value: number): Result<number, 'Hidden'> => err('Hidden') });
  const good = defineQuery('good-read', { needs: base, select: (value: number) => ok(value) });
  const app = createApplication(<Fragment><Query query={rejected} /><Query query={good} /></Fragment>);
  const screen = defineView({
    initial: () => 0, operations: {},
    queries: {
      bad: refreshQuery(rejected, { input: (_state: number) => undefined, on: [], reduce: (state: number) => state }),
      good: refreshQuery(good, { input: (_state: number) => undefined, on: [], reduce: (state: number, value) => state + value }),
    },
    view: state => ({ value: state.data, queries: state.queries }),
  });
  const session = await app.start(screen);
  assert.deepEqual(session.snapshot().view, { value: 3, queries: { bad: { kind: 'failed', error: 'Hidden' }, good: { kind: 'ready' } } });
  assert.equal(reads, 2);
  const throwing = await app.start({ ...screen, queries: {
    bad: refreshQuery(good, { input: (_state: number) => undefined, on: [], reduce: (_state: number): number => { throw new Error('projection failed'); } }),
    good: screen.queries!.good,
  }, view: state => ({ value: state.data, queries: state.queries }) });
  assert.equal(throwing.snapshot().view.queries.bad.kind, 'crashed'); assert.equal(throwing.snapshot().view.value, 3);
});

test('query aliases remain own data fields even when they match object prototype property names', async () => {
  const resource = defineResource('prototype-query-data', () => () => ok(1));
  const query = defineQuery('prototype-query', { needs: resource, select: (value: number) => ok(value) });
  const binding = refreshQuery(query, { input: (_state: number) => undefined, on: [], reduce: (state: number, value) => state + value });
  const app = createApplication(<Query query={query} />);
  const session = await app.start({ initial: () => 0, operations: {}, queries: { ['__proto__']: binding, constructor: binding }, view: state => state.data });
  assert.equal(session.snapshot().view, 2);
  assert.equal(Object.getPrototypeOf(session.snapshot().state.queries), Object.prototype);
  assert.equal(Object.hasOwn(session.snapshot().state.queries, '__proto__'), true);
  assert.deepEqual(session.snapshot().state.queries['__proto__'], { kind: 'ready' });
});
