/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, workflow, process, type Result, type Execution } from './framework/index.js';
import { h, Fragment, createContext, useContext, defineResource, defineEvent, emit, defineOperation, Operation, On, createApplication, type BusinessResource } from './framework/authoring.js';
const Owner = createContext<string>();
test('resources are resolved once per execution, retain internal live spans and capture separate Providers', async () => {
  let reads = 0;
  const resource = defineResource('owned-value', () => {
    const owner = useContext(Owner);
    return async (input: { id: string }): Promise<Result<string, 'Missing'>> => { reads++; return input.id === 'missing' ? err('Missing') : ok(owner); };
  });
  const op = defineOperation('resources', {
    needs: { first: resource, second: resource },
    execute: workflow('combine', (values: { first: string; second: string }) => ok(values.first + values.second)),
    useSave: () => async (value: string) => ok(value),
  });
  const spans: string[] = [];
  const a = createApplication(<Owner.Provider value="a"><Operation operation={op} /></Owner.Provider>, { observeExecution: event => { if (event.kind === 'span-started') spans.push(event.step); } });
  const b = createApplication(<Owner.Provider value="b"><Operation operation={op} /></Owner.Provider>);
  assert.equal(reads, 0);
  assert.deepEqual(await Promise.all([a.execute(op, { id: 'one' }), b.execute(op, { id: 'two' })]), [ok('aa'), ok('bb')]);
  assert.equal(reads, 2); assert(spans.includes('resource:owned-value'));
  assert.deepEqual(await a.execute(op, { id: 'missing' }), err('Missing')); assert.equal(reads, 3);
  assert.deepEqual(await a.execute(op, { id: 'again' }), ok('aa')); assert.equal(reads, 4);
});
test('resource failure stops later IO; incompatible requests and contexts are rejected by the type checker', async () => {
  let later = 0, saved = 0;
  const first = defineResource('first', () => async (input: { id: string }): Promise<Result<number, 'NoFirst'>> => err('NoFirst'));
  const second = defineResource('second', () => async (_input: { tenant: string }) => { later++; return ok(1); });
  const op = defineOperation('stopping', { needs: { first, second }, execute: ({ first, second }: { first: number; second: number }) => ok(first + second), useSave: () => async (value: number) => { saved++; return ok(value); } });
  const app = createApplication(<Operation operation={op} />);
  assert.deepEqual(await app.execute(op, { id: 'one', tenant: 'a' }), err('NoFirst')); assert.equal(later, 0); assert.equal(saved, 0);
  if (false) {
    // @ts-expect-error Every required resource input is necessary.
    void app.execute(op, { id: 'one' });
    // @ts-expect-error Resource context cannot satisfy a business function requiring another value type.
    defineOperation('bad-context', { needs: { first }, execute: (value: { first: string }) => ok(value), useSave: () => async (value: { first: string }) => ok(value) });
    // @ts-expect-error Save cannot consume an incompatible business result.
    defineOperation('bad-save', { needs: { first }, execute: (value: { first: number }) => ok(value.first), useSave: () => async (value: string) => ok(value) });
  }
});
test('On checks typed event inputs and mounting rejects unhandled events, duplicate names and cycles before IO', () => {
  const event = defineEvent<number>('number');
  const op = defineOperation('emit', { needs: {}, execute: () => ok(1), useSave: () => async (value: number) => ok(value), emits: [emit(event)] });
  assert.throws(() => createApplication(<Operation operation={op} />), /UnhandledEvent:number/);
  const input = defineResource('number-input', () => (value: number) => ok(value));
  const loop = defineOperation('loop', { needs: { input }, execute: ({ input }: { input: number }) => ok(input), useSave: () => async (value: number) => ok(value), emits: [emit(event)] });
  assert.throws(() => createApplication(<On event={event} operation={loop} />), /EventCycle:number/);
  const other = defineEvent<number>('number');
  const leaf = defineOperation('leaf', { needs: { input }, execute: ({ input }: { input: number }) => ok(input), useSave: () => async (value: number) => ok(value) });
  assert.throws(() => createApplication(<Fragment><Operation operation={op} /><On event={other} operation={leaf} /></Fragment>), /DuplicateEvent:number/);
  if (false) {
    // @ts-expect-error Identically named string and number events do not make their payloads compatible.
    void <On event={defineEvent<string>('string')} operation={leaf} />;
    // @ts-expect-error An event projection must produce the declared payload.
    void emit(event, (value: string) => value);
  }
});
test('fanout and chained events run after commit; receiver errors and defects are isolated and reported', async () => {
  const first = defineEvent<number>('first'), second = defineEvent<string>('second'), terminal = defineEvent<string>('external', { external: true });
  const number = defineResource('number', () => (input: number) => ok(input)), text = defineResource('text', () => (input: string) => ok(input));
  const order: string[] = [];
  const producer = defineOperation('producer', { needs: {}, execute: () => ok(1), useSave: () => async (value: number) => { order.push('commit'); return ok(value); }, emits: [emit(first)] });
  const failing = defineOperation('failing', { needs: { number }, execute: () => err('Rejected' as const), useSave: () => async (_value: never) => ok(null) });
  const throwing = defineOperation('throwing', { needs: { number }, execute: () => ok('value'), useSave: () => async (_value: string): Promise<Result<string, never>> => { throw new Error('offline'); } });
  const next = defineOperation('next', { needs: { number }, execute: ({ number }: { number: number }) => ok(String(number)), useSave: () => async (value: string) => { order.push('next'); return ok(value); }, emits: [emit(second)] });
  const last = defineOperation('last', { needs: { text }, execute: ({ text }: { text: string }) => ok(text), useSave: () => async (value: string) => { order.push('last'); return ok(value); }, emits: [emit(terminal)] });
  const tree = <Fragment><Operation operation={producer} /><On event={first} operation={failing} /><On event={first} operation={throwing} /><On event={first} operation={next} /><On event={second} operation={last} /></Fragment>;
  const app = createApplication(tree), received: string[] = [];
  const unsubscribe = app.subscribeDelivery(delivery => { received.push(delivery.status); });
  const report = await app.executeDetailed(producer, undefined); unsubscribe();
  assert.deepEqual(report.result, ok(1)); assert.deepEqual(order, ['commit', 'next', 'last']);
  assert.deepEqual(report.deliveries.map(row => row.status), ['error', 'defect', 'ok', 'ok', 'external']);
  assert.deepEqual(received, ['error', 'defect', 'ok', 'ok', 'external']);
  const limited = await createApplication(tree, { maxDeliveries: 1 }).executeDetailed(producer, undefined);
  assert(limited.result.ok); assert.equal(limited.deliveries.at(-1)?.status, 'limit');
});
test('emission projection defects happen before commit and replay never publishes a second notification', async () => {
  const event = defineEvent<number>('replay-event');
  let saves = 0, notifications = 0, receipt: number | undefined;
  const request = defineResource('request', () => (input: { id: string }) => ok(input));
  const producer = defineOperation('replayed', {
    needs: { request }, execute: () => ok(1), emits: [emit(event)],
    useSave: () => async (value: number): Promise<Result<Execution<number>, 'Conflict'>> => { saves++; receipt = value; return ok({ kind: 'committed', value }); },
    useReplay: () => ({ lookup: (_input: { id: string }): Result<{ kind: 'missing' } | { kind: 'found'; value: number }, 'LookupFailed'> => ok(receipt === undefined ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: (_error: 'Conflict') => false }),
  });
  const number = defineResource('event-value', () => (input: number) => ok(input));
  const receiver = defineOperation('receive', { needs: { number }, execute: () => ok(null), useSave: () => async (_value: null) => { notifications++; return ok(null); } });
  const app = createApplication(<Fragment><Operation operation={producer} /><On event={event} operation={receiver} /></Fragment>);
  const first = await app.executeDetailed(producer, { id: 'one' }), repeated = await app.executeDetailed(producer, { id: 'one' });
  assert.deepEqual(first.result, ok({ kind: 'committed', value: 1 })); assert.equal(first.publications.length, 1);
  assert.deepEqual(repeated.result, ok({ kind: 'replayed', value: 1 })); assert.equal(repeated.publications.length, 0);
  assert.equal(saves, 1); assert.equal(notifications, 1);
  const broken = defineOperation('broken-projection', { needs: {}, execute: () => ok(1), useSave: () => async (value: number) => { saves++; return ok(value); }, emits: [emit(event, (_value: number): number => { throw new Error('bad projection'); })] });
  const failed = createApplication(<Fragment><Operation operation={broken} /><On event={event} operation={receiver} /></Fragment>);
  await assert.rejects(failed.execute(broken, undefined), /bad projection/); assert.equal(saves, 1);
});
test('one resource can accept alternative requests, while selected resources require every possible input', async () => {
  const either = defineResource('either', () => (input: { id: string } | { tenant: string }) => ok('id' in input ? input.id : input.tenant));
  const op = defineOperation('either', { needs: { value: either }, execute: ({ value }: { value: string }) => ok(value), useSave: () => async (value: string) => ok(value) });
  const app = createApplication(<Operation operation={op} />);
  assert.deepEqual(await app.execute(op, { id: 'id' }), ok('id'));
  assert.deepEqual(await app.execute(op, { tenant: 'tenant' }), ok('tenant'));
  const id = defineResource('id', () => (input: { id: string }) => ok(input.id));
  const tenant = defineResource('tenant', () => (input: { tenant: string }) => ok(input.tenant));
  const choose = (flag: boolean) => flag ? id : tenant;
  const selected = defineOperation('selected', { needs: { value: choose(true) }, execute: ({ value }: { value: string }) => ok(value), useSave: () => async (value: string) => ok(value) });
  const selectedApp = createApplication(<Operation operation={selected} />);
  assert.deepEqual(await selectedApp.execute(selected, { id: 'id', tenant: 'tenant' }), ok('id'));
  if (false) {
    // @ts-expect-error A selected resource may require tenant instead of id.
    void selectedApp.execute(selected, { id: 'id' });
  }
});
test('nested detailed Hook composition propagates child publications and captures Provider scopes independently', async () => {
  const event = defineEvent<string>('nested');
  const owner = defineResource('owner', () => { const value = useContext(Owner); return () => ok(value); });
  const child = defineOperation('child', { needs: { owner }, execute: ({ owner }: { owner: string }) => ok(owner), useSave: () => async (value: string) => ok(value), emits: [emit(event)] });
  const parent = defineOperation('parent', () => {
    const childHandler = child.use();
    return { load: async (_input: { id: string }) => ok({}), execute: process<{}>().effect('child', childHandler), save: async (value: string) => ok(value) };
  });
  const payload = defineResource('payload', () => (value: string) => ok(value));
  const sent: string[] = [];
  const receiver = defineOperation('receiver', { needs: { payload, owner }, execute: ({ payload, owner }: { payload: string; owner: string }) => ok(`${payload}:${owner}`), useSave: () => async (value: string) => { sent.push(value); return ok(value); } });
  const app = (producerOwner: string, consumerOwner: string) => createApplication(<Fragment>
    <Owner.Provider value={producerOwner}><Operation operation={parent} /></Owner.Provider>
    <Owner.Provider value={consumerOwner}><On event={event} operation={receiver} /></Owner.Provider>
  </Fragment>);
  const a = app('a', 'receiver-a'), b = app('b', 'receiver-b');
  assert.deepEqual(await Promise.all([a.execute(parent, { id: 'one' }), b.execute(parent, { id: 'two' })]), [ok('a'), ok('b')]);
  assert.deepEqual(sent.sort(), ['a:receiver-a', 'b:receiver-b']);
  // A child commit survives a later parent failure, including during delivery.
  const requested = defineEvent<{ id: string }>('nested-requested');
  const source = defineOperation('source', { needs: {}, execute: () => ok({ id: 'three' }), useSave: () => async (value: { id: string }) => ok(value), emits: [emit(requested)] });
  const failingParent = defineOperation('failing-parent', () => {
    const childHandler = child.use();
    return { load: async (_input: { id: string }) => ok({}), execute: process<{}>().effect('child', childHandler), save: async (_value: string) => err('ParentFailed' as const) };
  });
  const failed = createApplication(<Owner.Provider value="committed-child"><Fragment>
    <Operation operation={source} /><On event={requested} operation={failingParent} /><On event={event} operation={receiver} />
  </Fragment></Owner.Provider>);
  const detail = await failed.executeDetailed(source, undefined);
  assert.deepEqual(detail.deliveries.map(row => row.status), ['error', 'ok']);
  assert.equal(sent.at(-1), 'committed-child:committed-child');
});

test('dependent resource graphs infer acquisition order, share fetched facts, and stop before dependent IO on failure', async () => {
  let reads = 0, profiles = 0, saves = 0;
  const booking = defineResource('booking', () => async (input: { id: string }): Promise<Result<{ id: string; owner: string }, 'Missing'>> => {
    reads++; return input.id === 'missing' ? err('Missing') : ok({ id: input.id, owner: 'alice' });
  });
  const profile = defineResource('profile', { needs: { booking }, useLoad: () => async ({ booking }: { booking: { id: string; owner: string } }): Promise<Result<string, 'NoProfile'>> => {
    profiles++; return booking.id === 'blocked' ? err('NoProfile') : ok(booking.owner);
  } });
  const op = defineOperation('dependent', { needs: { profile, booking }, execute: ({ profile }: { profile: string }) => ok(profile), useSave: () => async (value: string) => { saves++; return ok(value); } });
  const app = createApplication(<Operation operation={op} />);
  const report = await app.executeDetailed(op, { id: 'one' });
  assert.deepEqual(report.result, ok('alice')); assert.equal(reads, 1); assert.equal(profiles, 1);
  assert.deepEqual(report.trace.filter(row => row.step.startsWith('resource:')).map(row => row.step), ['resource:booking', 'resource:profile']);
  assert.deepEqual(await app.execute(op, { id: 'missing' }), err('Missing')); assert.equal(profiles, 1); assert.equal(saves, 1);
  assert.deepEqual(await app.execute(op, { id: 'blocked' }), err('NoProfile')); assert.equal(reads, 3); assert.equal(profiles, 2); assert.equal(saves, 1);
  if (false) {
    // @ts-expect-error The transitive resource input is still required.
    void app.execute(op, {});
    // @ts-expect-error Dependency data cannot satisfy an incompatible loader.
    defineResource('bad-profile', { needs: { booking }, useLoad: () => (context: { booking: string }) => ok(context) });
  }
});
test('resource cycles and accessor declarations are rejected before acquisition', () => {
  const needs: Record<string, BusinessResource<never, unknown, unknown>> = {};
  const cycle = defineResource('cycle', { needs, useLoad: () => () => ok('value') });
  needs.self = cycle;
  const op = defineOperation('cyclic', { needs: { cycle }, execute: () => ok(1), useSave: () => async (value: number) => ok(value) });
  assert.throws(() => createApplication(<Operation operation={op} />), /ResourceCycle:cycle/);
  let reads = 0;
  const valid = defineResource('valid', () => { reads++; return () => ok(1); });
  const fields = Object.defineProperty({ valid }, 'hidden', { get() { reads++; return valid; } });
  const invalid = defineOperation('accessor', { needs: fields, execute: () => ok(1), useSave: () => async (value: number) => ok(value) });
  assert.throws(() => createApplication(<Operation operation={invalid} />), /NeedsRequireDataFields/); assert.equal(reads, 0);
});
test('a connected operation snapshots request data before asynchronous resource acquisition', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const first = defineResource('first', () => async (input: { id: string }) => { entered(); await gate; return ok(input.id); });
  const second = defineResource('second', () => (input: { id: string }) => ok(input.id));
  const op = defineOperation('snapshot', { needs: { first, second }, execute: (values: { first: string; second: string }) => ok(values), useSave: () => async (value: { first: string; second: string }, input: { id: string }) => ok({ ...value, savedId: input.id }) });
  const app = createApplication(<Operation operation={op} />), input = { id: 'original' };
  const result = app.execute(op, input); await ready; input.id = 'changed'; release();
  assert.deepEqual(await result, ok({ first: 'original', second: 'original', savedId: 'original' }));
});

test('runtime-selected resource and table declarations require the input of every possible branch', async () => {
  const id = defineResource('selected-id', () => (input: { id: string }) => ok(input.id));
  const tenant = defineResource('selected-tenant', () => (input: { tenant: string }) => ok(input.tenant));
  for (const selected of [true, false]) {
    const needs = selected ? id : { tenant };
    const op = defineOperation('selected-spec', { needs, execute: (_value: unknown) => ok(1), useSave: () => async (value: number) => ok(value) });
    const tableNeeds: { id: typeof id } | { tenant: typeof tenant } = selected ? { id } : { tenant };
    const tables = defineOperation('selected-tables', { needs: tableNeeds, execute: (_value: unknown) => ok(1), useSave: () => async (value: number) => ok(value) });
    const app = createApplication(<Fragment><Operation operation={op} /><Operation operation={tables} /></Fragment>);
    assert.deepEqual(await app.execute(op, { id: 'one', tenant: 'two' }), ok(1));
    assert.deepEqual(await app.execute(tables, { id: 'one', tenant: 'two' }), ok(1));
    if (false) {
      // @ts-expect-error The selected table could require tenant.
      void app.execute(op, { id: 'one' });
      // @ts-expect-error The selected direct resource could require id.
      void app.execute(op, { tenant: 'two' });
      // @ts-expect-error Disjoint table alternatives still require every candidate's input.
      void app.execute(tables, { id: 'one' });
    }
  }
});
