import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operation, ok, err, type Result, type ActionReport, type ExecutionEvent } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { story, actor, type Inspectable } from './experiments/procurement/comparison-scenario.js';
import { operations, readCounts, relatedCounts, ruleSteps } from './experiments/procurement/failure-testing.js';
import type { StudyCommands, StudyFactory } from './experiments/procurement/comparison-contract.js';

type IO = { method: 'read' | 'related' | 'commit'; kind: string; id: string };
type Command = {
  run(input: unknown): Promise<Result<unknown, unknown>>;
  runDetailed(input: unknown): Promise<ActionReport<unknown, unknown>>;
};
const namespaces: Record<string, string> = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' };

for (const backend of ['memory', 'sqlite'] as const) for (const observed of [false, true]) {
  test(`Application contains exercised procurement IO exceptions without retry: ${backend}/observed=${observed}`, async () => {
    const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
    const calls: IO[] = [], positions = new Set<string>();
    let preflight = false, attempted = 0, committed = 0, delivered = 0, completed = 0;
    let armed: { left: number; cause: Error; delivery: 'throw' | 'reject' } | undefined;
    function touch(event: IO): Promise<never> | undefined {
      calls.push(event);
      if (armed && --armed.left === 0) {
        const fault = armed; armed = undefined; delivered++;
        if (fault.delivery === 'throw') throw fault.cause;
        return Promise.reject(fault.cause);
      }
    }
    const tracked: Inspectable = {
      read: (kind, id, identity) => touch({ method: 'read', kind, id }) ?? repository.read(kind, id, identity),
      related: (kind, id, identity) => touch({ method: 'related', kind, id }) ?? repository.related(kind, id, identity),
      list: repository.list.bind(repository),
      commit: (change, identity) => {
        attempted++;
        const failure = touch({ method: 'commit', kind: change.result.kind, id: change.result.id });
        if (failure) return failure;
        if (preflight) return Promise.resolve(err({ kind: 'Conflict' as const }));
        committed++; return repository.commit(change, identity);
      },
    };
    const snapshot = () => (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor('finance')));
    const wrapped: StudyFactory = (port, identity, policy) => {
      const declared = procurement(port, identity, policy);
      assert.deepEqual(Object.entries(declared).flatMap(([group, table]) => Object.keys(table).map(name => `${group}.${name}`)).sort(), operations);
      const tables: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, unknown>>>> = {};
      for (const [group, entries] of Object.entries(declared)) {
        const table: Record<string, (input: unknown) => Promise<Result<unknown, unknown>>> = {};
        for (const [name, entry] of Object.entries(entries)) {
          // Only the heterogeneous fixture dispatch is erased; public commands remain checked at declaration.
          const command = entry as unknown as Command;
          table[name] = async input => {
            const operationName = `${group}.${name}`, id = `procurement.${namespaces[group]}.v1.${name}`;
            const before = snapshot(), original = structuredClone(input), from = calls.length, realBefore = committed, attemptsBefore = attempted;
            preflight = true;
            try { assert.deepEqual((await command.runDetailed(input)).result, err({ kind: 'Conflict' }), operationName); }
            finally { preflight = false; }
            const timeline = calls.slice(from);
            assert.equal(timeline.filter(event => event.method === 'read').length, readCounts[operationName]);
            assert.equal(timeline.filter(event => event.method === 'related').length, relatedCounts[operationName]);
            assert.equal(timeline.filter(event => event.method === 'commit').length, 1);
            assert.equal(timeline.at(-1)?.method, 'commit');
            assert.deepEqual(snapshot(), before); assert.equal(committed, realBefore);
            let projections = 0, tick = 0;
            const events: ExecutionEvent[] = [], states: string[] = [];
            const initial = { completed: 7, value: 'previous-projection' as unknown };
            const session = await defineApplication({ initial: () => initial,
              operations: { execute: operation(command, (state: typeof initial, value) => { projections++; return { completed: state.completed + 1, value }; }) },
              view: state => ({ busy: state.kind === 'running', error: state.kind === 'crashed' ? state.error.kind : null }),
            }).start(observed ? { sessionId: 'procurement-fixture', clock: () => tick++, observeExecution: event => { events.push(event); } } : undefined);
            session.subscribe(value => { states.push(value.state.kind); });
            for (const [index, target] of timeline.entries()) for (const delivery of ['throw', 'reject'] as const) {
              const start = calls.length, deliveredBefore = delivered;
              const cause = new Error('private-storage-exception');
              events.length = 0; states.length = 0;
              armed = { left: index + 1, cause, delivery };
              try {
                const accepted = await session.dispatch({ type: 'execute', input });
                assert(accepted.ok);
              } finally { armed = undefined; }
              assert.equal(delivered, deliveredBefore + 1); completed++;
              positions.add(`${operationName}#${index + 1}`);
              assert.deepEqual(calls.slice(start), timeline.slice(0, index + 1));
              assert.deepEqual(snapshot(), before); assert.equal(committed, realBefore); assert.equal(projections, 0);
              assert.deepEqual(states, ['running', 'crashed']);
              const crashed = session.snapshot();
              assert.deepEqual(crashed.state, { kind: 'crashed', data: initial, operation: 'execute', error: { kind: 'UnexpectedException', message: cause.message } });
              assert.deepEqual(crashed.view, { busy: false, error: 'UnexpectedException' });
              if (observed) {
                assert.deepEqual(events.filter(event => event.kind === 'completed').map(event => event.status), ['defect']);
                assert.deepEqual(events.filter(event => event.kind === 'step'), []); // No fabricated report after rejection.
                const spans = events.filter(event => event.kind === 'span-completed');
                const loadOrSave = target.method === 'commit' ? id : `${id}:load`;
                assert(spans.some(event => event.step === loadOrSave && event.status === 'defect'), operationName);
                for (const step of target.method === 'commit' ? ruleSteps(operationName) : []) assert(spans.some(event => event.step === step && event.status === 'ok'));
                const starts = events.filter(event => event.kind === 'span-started').map(event => event.spanId).sort();
                assert.deepEqual(spans.map(event => event.spanId).sort(), starts);
                assert(events.every(event => Object.isFrozen(event) && event.operation === 'execute' && event.executionId === events[0]?.executionId));
                assert(!JSON.stringify(events).includes(cause.message));
              } else assert.deepEqual(events, []);
              const blockedAt = calls.length;
              assert.deepEqual(await session.dispatch({ type: 'execute', input }), err({ kind: 'UnexpectedMessage' }));
              assert.deepEqual(session.snapshot(), crashed); assert.equal(calls.length, blockedAt);
              assert((await session.dispatch({ type: 'dismiss' })).ok);
              assert.deepEqual(session.snapshot().state, { kind: 'ready', data: initial });
              assert.equal(calls.length, blockedAt); assert.equal(projections, 0); assert.equal(committed, realBefore);
            }
            const validAt = calls.length;
            assert((await session.dispatch({ type: 'execute', input })).ok);
            const ready = session.snapshot().state;
            assert.equal(ready.kind, 'ready'); assert.equal(ready.data.completed, 8); assert.equal(projections, 1);
            assert.equal(committed, realBefore + 1); assert.equal(attempted, attemptsBefore + 4);
            assert.deepEqual(calls.slice(validAt), timeline); assert.deepEqual(input, original);
            return ok(ready.data.value);
          };
        }
        tables[group] = table;
      }
      return tables as StudyCommands;
    };
    try {
      const actual = await story(wrapped, tracked);
      const reference = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
      try { assert.deepEqual(actual, await story(procurement, reference)); }
      finally { if (reference instanceof SqliteProcurement) reference.close(); }
      const expected = operations.flatMap(name => Array.from({ length: readCounts[name]! + relatedCounts[name]! + 1 }, (_, index) => `${name}#${index + 1}`)).sort();
      assert.equal(expected.length, 72); assert.deepEqual([...positions].sort(), expected);
      assert.equal(completed, 178); assert.equal(delivered, 178); assert.equal(committed, 32); assert.equal(attempted, 128);
    } finally { if (repository instanceof SqliteProcurement) repository.close(); }
  });
}
