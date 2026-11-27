/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err } from './framework/index.js';
import { h, Fragment, Guard, ExecutionDenied, createApplicationTemplate, createContext, useContext, defineOperation, defineQuery, defineResource, Query, Operation, defineEvent, emit, On } from './framework/authoring.js';

const Actor = createContext<{ id: string; admin: boolean }>();
function RequireAdmin({ children }: { children: h.JSX.Element }) {
  return <Guard useCheck={() => { const actor = useContext(Actor); return () => actor.admin ? ok(undefined) : err('AdminRequired' as const); }}>{children}</Guard>;
}
test('one tree creates isolated concurrent execution scopes and denies before replay lookup or IO', async () => {
  let lookups = 0, loads = 0, saves = 0;
  const op = defineOperation('scoped.change', () => {
    const actor = useContext(Actor);
    return {
      load: async (input: number) => { loads++; await Promise.resolve(); return ok({ input, actor: actor.id }); },
      execute: (value: { input: number; actor: string }) => ok(value),
      save: async (value: { input: number; actor: string }) => { saves++; return ok({ kind: 'committed' as const, value }); },
      replay: { lookup: async (_input: number) => { lookups++; return ok({ kind: 'missing' as const }); }, resolveAfter: (_error: never) => false },
    };
  });
  const template = createApplicationTemplate(<RequireAdmin><Operation operation={op} /></RequireAdmin>);
  const admin = template.scope(children => <Actor.Provider value={{ id: 'admin', admin: true }}>{children}</Actor.Provider>);
  const other = template.scope(children => <Actor.Provider value={{ id: 'other', admin: false }}>{children}</Actor.Provider>);
  assert.equal(lookups + loads + saves, 0);
  const results = await Promise.allSettled([admin.execute(op, 1), other.execute(op, 2)]);
  assert.deepEqual(results[0], { status: 'fulfilled', value: ok({ kind: 'committed', value: { input: 1, actor: 'admin' } }) });
  assert.equal(results[1]!.status, 'rejected');
  if (results[1]!.status === 'rejected') assert(results[1].reason instanceof ExecutionDenied);
  assert.deepEqual([lookups, loads, saves], [1, 1, 1]);
  // The gate still runs on every invocation, including attempted cached replays.
  await assert.rejects(other.executeDetailed(op, 2), ExecutionDenied);
  assert.deepEqual([lookups, loads, saves], [1, 1, 1]);
});

test('event consumers retain their own guards and denial preserves producer commit', async () => {
  let commits = 0, receiverLoads = 0;
  const event = defineEvent<number>('scope.changed', { decode: value => typeof value === 'number' ? ok(value) : err('Invalid') });
  const producer = defineOperation('scope.produce', { needs: {}, execute: () => ok(1), emits: [emit(event)], useSave: () => async (n: number) => { commits++; return ok(n); } });
  const receiver = defineOperation('scope.receive', () => ({ load: async (n: number) => { receiverLoads++; return ok(n); }, execute: (n: number) => ok(n), save: async (n: number) => ok(n) }));
  const template = createApplicationTemplate(<Fragment><Operation operation={producer} /><RequireAdmin><On event={event} operation={receiver} /></RequireAdmin></Fragment>);
  const session = template.scope(children => <Actor.Provider value={{ id: 'member', admin: false }}>{children}</Actor.Provider>);
  const report = await session.executeDetailed(producer, {});
  assert.deepEqual(report.result, ok(1));
  assert.equal(commits, 1); assert.equal(receiverLoads, 0);
  assert.equal(report.deliveries[0]?.status, 'denied');
  await session.deliver({ id: 'persisted', type: event.name, payload: 1 });
  assert.equal(receiverLoads, 0);
});

test('guards compose outer first and protect custom Hook handlers without JSX registration', async () => {
  const checks: string[] = []; let loads = 0;
  const child = defineOperation('scope.child', () => ({ load: async (n: number) => { loads++; return ok(n); }, execute: (n: number) => ok(n), save: async (n: number) => ok(n) }));
  const parent = defineOperation('scope.parent', () => {
    const handler = child.use();
    return { load: async (n: number) => ok(n), execute: handler, save: async (n: number) => ok(n) };
  });
  const template = createApplicationTemplate(<Guard useCheck={() => () => { checks.push('outer'); return ok(undefined); }}><Guard useCheck={() => operation => { checks.push('inner'); return operation.name === child.name ? err('Denied') : ok(undefined); }}><Operation operation={parent} /></Guard></Guard>);
  await assert.rejects(template.scope(children => children).execute(parent, 1), ExecutionDenied);
  assert.deepEqual(checks, ['outer', 'inner', 'outer', 'inner']); assert.equal(loads, 0);
});


test('query guards recheck authorization before every read', async () => {
  let allowed = true, reads = 0;
  const resource = defineResource('scope.read', () => async (id: string) => { reads++; return ok(id); });
  const query = defineQuery('scope.query', { needs: resource, select: (id: string) => ok(id) });
  const template = createApplicationTemplate(<Guard useCheck={() => () => allowed ? ok(undefined) : err('Revoked')}><Query query={query} /></Guard>);
  const session = template.scope(children => children);
  assert.deepEqual(await session.execute(query, 'one'), ok('one'));
  allowed = false;
  await assert.rejects(session.execute(query, 'one'), ExecutionDenied);
  assert.equal(reads, 1);
});


test('execution observers distinguish policy denial from programmer defects', async () => {
  const statuses: string[] = [];
  const denied = defineOperation('scope.denied', () => ({ load: async (n: number) => ok(n), execute: (n: number) => ok(n), save: async (n: number) => ok(n) }));
  const broken = defineOperation('scope.broken', () => ({ load: async (n: number) => ok(n), execute: (_n: number): ReturnType<typeof ok<number>> => { throw new Error('bug'); }, save: async (n: number) => ok(n) }));
  const template = createApplicationTemplate(<Fragment><Guard useCheck={() => () => err('NoAccess')}><Operation operation={denied} /></Guard><Operation operation={broken} /></Fragment>, {
    observeExecution: event => { if (event.kind === 'completed') statuses.push(event.status); },
  });
  const app = template.scope(children => children);
  await assert.rejects(app.execute(denied, 1), ExecutionDenied);
  await assert.rejects(app.execute(broken, 1), /bug/);
  assert.deepEqual(statuses, ['denied', 'defect']);
});
