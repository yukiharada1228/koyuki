import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProgram, defineApplication, next, effect, operation, business, workflow, ok, err, type Update, type Result } from './framework/index.js';
const cloneError = { name: 'DataCloneError' };
function invalidData() {
  class Domain { #amount = 2; amount() { return this.#amount; } }
  const prototype = Object.assign(Object.create(null), { constructor: Object, method: () => 2 });
  const custom = Object.assign(Object.create(prototype), { amount: 2 });
  return [custom, { [Symbol('proof')]: true }, { value: new Domain() }, Object.defineProperty({ amount: 2 }, 'hidden', { value: true })];
}

test('invalid initial program state fails before initial effects or presentation', async () => {
  for (const data of invalidData()) {
    let effects = 0, views = 0;
    type Message = { type: 'done' };
    const command = effect('initial', async (_: null) => { effects++; return null; }, (): Message => ({ type: 'done' }));
    const program = defineProgram({ init: (): Update<unknown, Message> => next(data, command(null)),
      update: (state: unknown) => ok(next<unknown, Message>(state)), view: (_state: unknown) => { views++; return 0; },
    });
    await assert.rejects(program.start(), cloneError); assert.equal(effects, 0); assert.equal(views, 0);
  }
});

test('invalid initial application state is not normalized into a different model', async () => {
  for (const data of invalidData()) {
    let runs = 0;
    const app = defineApplication({ initial: (): unknown => data,
      operations: { change: operation({ run: async (input: number) => { runs++; return ok(input); } }, (_before: unknown, output) => output) },
      view: state => state.kind,
    });
    await assert.rejects(app.start(), cloneError); assert.equal(runs, 0);
  }
});

test('external program events reject before update, revision, notification and effects', async () => {
  type Message = { type: 'change' | 'done'; input: unknown };
  let updates = 0, writes = 0, notices = 0;
  const persist = effect('persist', async (value: number) => { writes++; return value; }, (input): Message => ({ type: 'done', input }));
  const session = await defineProgram({ init: (): Update<number, Message> => next(0),
    update: (before: number, message: Message) => {
      updates++; if (typeof message.input !== 'number') return err('Invalid' as const);
      return ok(message.type === 'change' ? next(before, persist(message.input)) : next<number, Message>(message.input));
    }, view: value => value,
  }).start();
  session.subscribe(() => { notices++; });
  for (const input of invalidData()) await assert.rejects(session.dispatch({ type: 'change', input }), cloneError);
  assert.equal(updates, 0); assert.equal(writes, 0); assert.equal(notices, 1);
  assert.equal(session.snapshot().revision, 0); assert.deepEqual(session.trace(), []);
  assert((await session.dispatch({ type: 'change', input: 3 })).ok);
  assert.equal(session.snapshot().state, 3); assert.equal(writes, 1);
});

test('application routing does not evaluate event accessors or strip root proof', async () => {
  let getters = 0, runs = 0;
  const session = await defineApplication({ initial: () => 0,
    operations: { change: operation({ run: async (value: number) => { runs++; return ok(value); } }, (_before: number, value) => value) },
    view: state => state.data,
  }).start();
  const events = [
    { get type(): 'change' { getters++; return 'change'; }, input: 2 },
    { type: 'change' as const, get input() { getters++; return 2; } },
    { type: 'change' as const, input: 2, [Symbol('proof')]: true },
  ];
  for (const event of events) await assert.rejects(session.dispatch(event), cloneError);
  assert.equal(getters, 0); assert.equal(runs, 0); assert.equal(session.snapshot().revision, 0);
  assert.deepEqual(session.trace(), []);
  assert((await session.dispatch({ type: 'change', input: 2 })).ok); assert.equal(runs, 1); assert.equal(session.snapshot().view, 2);
});

test('invalid reducer state does not commit, publish or run followup commands', async () => {
  type State = { amount: number; evidence?: unknown };
  type Message = { type: 'bad' | 'good' | 'done' };
  for (const evidence of invalidData()) {
    let effects = 0, notices = 0;
    const followup = effect('followup', async (_: null) => { effects++; return null; }, (): Message => ({ type: 'done' }));
    const session = await defineProgram({ init: (): Update<State, Message> => next({ amount: 1 }),
      update: (before: State, event: Message) => {
        if (event.type === 'bad') { before.amount = 99; return ok(next({ amount: 2, evidence }, followup(null))); }
        return ok(next<State, Message>({ amount: 3 }));
      }, view: state => state.amount,
    }).start();
    session.subscribe(() => { notices++; });
    await assert.rejects(session.dispatch({ type: 'bad' }), cloneError);
    assert.deepEqual(session.snapshot().state, { amount: 1 }); assert.equal(session.snapshot().revision, 0);
    assert.equal(effects, 0); assert.equal(notices, 1);
    assert.deepEqual(session.trace(), [{ revision: 0, kind: 'event', name: 'bad', status: 'error' }]);
    assert((await session.dispatch({ type: 'good' })).ok); assert.equal(session.snapshot().state.amount, 3); assert.equal(session.snapshot().revision, 1);
  }
});

test('completion snapshot failure stops later commands without repeating an already executed effect', async () => {
  type State = { amount: number; evidence?: unknown };
  type Message = { type: 'begin' | 'done' | 'after' | 'recover' };
  let writes = 0, after = 0;
  const write = effect('write', async (_: null) => { writes++; return null; }, (): Message => ({ type: 'done' }));
  const later = effect('later', async (_: null) => { after++; return null; }, (): Message => ({ type: 'after' }));
  const session = await defineProgram({ init: (): Update<State, Message> => next({ amount: 1 }),
    update: (before: State, message: Message) => {
      if (message.type === 'begin') return ok(next(before, write(null)));
      if (message.type === 'done') return ok(next({ amount: 2, evidence: { [Symbol('proof')]: true } }, later(null)));
      return ok(next<State, Message>({ amount: 7 }));
    }, view: state => state.amount,
  }).start();
  await assert.rejects(session.dispatch({ type: 'begin' }), cloneError);
  assert.equal(writes, 1); assert.equal(after, 0); assert.equal(session.snapshot().revision, 1); assert.equal(session.snapshot().view, 1);
  assert.deepEqual(session.trace().at(-1), { revision: 1, kind: 'event', name: 'done', status: 'error' });
  assert((await session.dispatch({ type: 'recover' })).ok); assert.equal(session.snapshot().view, 7); assert.equal(writes, 1);
});

test('trusted command completions may project opaque domain objects into data state', async () => {
  class Completed { readonly type = 'done'; #amount = 7; amount() { return this.#amount; } }
  type Message = Completed;
  const read = effect('read', async (_: null) => new Completed(), message => message);
  const session = await defineProgram({ init: (): Update<{ amount: number }, Message> => next({ amount: 0 }, read(null)),
    update: (_before: { amount: number }, message: Message) => ok(next<{ amount: number }, Message>({ amount: message.amount() })),
    view: state => state.amount,
  }).start();
  assert.equal(session.snapshot().view, 7); assert.equal(session.snapshot().revision, 1);
});

test('application projection failure becomes crashed with the previous data and no automatic retry', async () => {
  let runs = 0;
  const session = await defineApplication({ initial: () => ({ amount: 1, evidence: null as unknown }),
    operations: { change: operation({ run: async (bad: boolean) => { runs++; return ok(bad); } }, (before: { amount: number; evidence: unknown }, bad) => {
      before.amount = 99; return { amount: 2, evidence: bad ? { [Symbol('proof')]: true } : null };
    }) }, view: state => state,
  }).start();
  assert((await session.dispatch({ type: 'change', input: true })).ok);
  const failed = session.snapshot().state; assert.equal(failed.kind, 'crashed'); assert.deepEqual(failed.data, { amount: 1, evidence: null });
  assert.equal(runs, 1); assert.deepEqual(await session.dispatch({ type: 'change', input: false }), err({ kind: 'UnexpectedMessage' })); assert.equal(runs, 1);
  await session.dispatch({ type: 'dismiss' }); assert((await session.dispatch({ type: 'change', input: false })).ok);
  assert.equal(session.snapshot().state.kind, 'ready'); assert.equal(session.snapshot().state.data.amount, 2); assert.equal(runs, 2);
});

test('unsupported domain error values are not stored as malformed failed states', async () => {
  class Denied { readonly kind = 'Denied'; #reason = 'policy'; reason() { return this.#reason; } }
  let runs = 0, reductions = 0;
  const session = await defineApplication({ initial: () => 7,
    operations: { change: operation({ run: async (_: null): Promise<Result<number, Denied>> => { runs++; return err(new Denied()); } }, (before: number) => { reductions++; return before; }) },
    view: state => state,
  }).start();
  assert((await session.dispatch({ type: 'change', input: null })).ok);
  const state = session.snapshot().state; assert(state.kind === 'crashed'); assert.equal(state.data, 7);
  assert.equal(state.error.kind, 'UnexpectedException'); assert.equal(runs, 1); assert.equal(reductions, 0);
});

test('opaque operation results can be reduced to snapshot-compatible application data', async () => {
  const proof = Symbol('approved');
  class Approved { readonly [proof] = true; #amount = 4; amount() { return this.#amount; } }
  const session = await defineApplication({ initial: () => 0,
    operations: { change: operation({ run: async (_: null) => ok(new Approved()) }, (_before: number, value) => { assert(value[proof]); return value.amount(); }) },
    view: state => state.data,
  }).start();
  assert((await session.dispatch({ type: 'change', input: null })).ok); assert.equal(session.snapshot().view, 4);
});

test('capture snapshot failures remain diagnostics and cannot change a committed business result', async () => {
  let saves = 0, getters = 0;
  const commands = business({ name: 'observed', load: async (n: number) => ok(n), save: async (n: number) => { saves++; return ok(n); }, operations: { change: [(n: number) => ok(n)] } });
  const value = { get proof() { getters++; return true; } };
  const report = await commands.change.runDetailed(2, { input: () => value, result: result => result.ok });
  assert.deepEqual(report.result, ok(2)); assert.equal(saves, 1); assert.equal(getters, 0); assert.equal(report.observations.length, 0);
  assert.equal(report.observationErrors.length, 3); assert(report.observationErrors.every(error => error.phase === 'input'));
  const resultFailure = await commands.change.runDetailed(3, { input: value => Number(value), result: (_result, step) => step === 'observed.change' ? { [Symbol('proof')]: true } : true });
  assert.deepEqual(resultFailure.result, ok(3)); assert.equal(saves, 2); assert.equal(resultFailure.observations.length, 2);
  assert.deepEqual(resultFailure.observationErrors, [{ step: 'observed.change', phase: 'result', kind: 'CaptureFailed' }]);
});

test('pure workflow capture does not return observations with silently erased proof', () => {
  let rules = 0;
  const flow = workflow('validate', (n: number) => { rules++; return ok(n); });
  assert.throws(() => flow.inspect(2, { input: () => ({ [Symbol('proof')]: true }), result: result => result.ok }), cloneError);
  assert.equal(rules, 0);
});

test('null-prototype state remains null through state updates, snapshots and views', async () => {
  const state: { amount: number } = Object.assign(Object.create(null), { amount: 1 });
  const session = await defineProgram({ init: (): Update<typeof state, { type: 'add' }> => next(state),
    update: (before: typeof state) => { assert.equal(Object.getPrototypeOf(before), null); before.amount++; return ok(next<typeof state, { type: 'add' }>(before)); },
    view: value => { assert.equal(Object.getPrototypeOf(value), null); return value.amount; },
  }).start();
  assert((await session.dispatch({ type: 'add' })).ok); const snapshot = session.snapshot();
  assert.equal(snapshot.view, 2); assert.equal(Object.getPrototypeOf(snapshot.state), null); assert.equal(state.amount, 1);
});

test('views may return symbols and functions without becoming application state', async () => {
  const rendered = Symbol('rendered');
  const session = await defineApplication({ initial: () => 1,
    operations: { add: operation({ run: async (amount: number) => ok(amount) }, (before: number, amount) => before + amount) },
    view: state => ({ [rendered]: true, render: () => state.data }),
  }).start();
  const first = session.snapshot(); assert(first.view[rendered]); assert.equal(first.view.render(), 1);
  assert((await session.dispatch({ type: 'add', input: 2 })).ok);
  assert.equal(session.snapshot().view.render(), 3); assert.equal(first.view.render(), 1);
});
