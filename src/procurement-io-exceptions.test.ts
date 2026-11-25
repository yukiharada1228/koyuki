import test from 'node:test';
import assert from 'node:assert/strict';
import { err, type Result, type ActionReport, type WorkflowCapture, type ObservationReport } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { baselineDetail } from './experiments/procurement/baseline-detail.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { story, actor, type Inspectable } from './experiments/procurement/comparison-scenario.js';
import { operations, split, readCounts, relatedCounts } from './experiments/procurement/failure-testing.js';
import type { Actor, Policy } from './experiments/procurement/domain.js';
import type { StudyCommands, StudyFactory } from './experiments/procurement/comparison-contract.js';
type Detail<C> = C extends (input: infer I) => Promise<Result<infer O, infer E>> ? { runDetailed: {
  (input: I): Promise<ActionReport<O, E>>;
  (input: I, capture: WorkflowCapture<null, boolean>): Promise<ActionReport<O, E> & ObservationReport<null, boolean>>;
} } : never;
type Detailed = { [G in keyof StudyCommands]: { [K in keyof StudyCommands[G]]: Detail<StudyCommands[G][K]> } };
type Factory = (repository: ProcurementRepository, identity: Actor, policy: Policy) => Detailed;
const builders: Record<string, Factory> = {
  koyuki: procurement,
  plain: (repository, identity, policy) => baselineDetail(plainProcurement, repository, identity, policy),
  helper: (repository, identity, policy) => baselineDetail(helperProcurement, repository, identity, policy),
};
const namespaces: Record<string, string> = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' };
type Mode = 'selected' | 'input-failure' | 'result-failure';
type IO = { method: 'read' | 'related' | 'commit'; kind: string; id: string };
type Event = { phase: 'input' | 'result'; step: string; ok?: boolean };
async function run(build: Factory, backend: string, mode: Mode) {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  const calls: IO[] = [], cases: { operation: string; at: number; delivery: string; events: Event[] }[] = [];
  let commitAttempts = 0, realCommits = 0, delivered = 0, inputSelections = 0, resultSelections = 0, preflight = false;
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
      commitAttempts++;
      const failure = touch({ method: 'commit', kind: change.result.kind, id: change.result.id });
      if (failure) return failure;
      if (preflight) return Promise.resolve(err({ kind: 'Conflict' as const }));
      realCommits++; return repository.commit(change, identity);
    },
  };
  const snapshot = () => (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).flatMap(kind => repository.list(kind, actor('finance')));
  const wrapped: StudyFactory = (port, identity, policy) => {
    const declared = build(port, identity, policy);
    assert.deepEqual(Object.entries(declared).flatMap(([group, table]) => Object.keys(table).map(name => `${group}.${name}`)).sort(), operations);
    const tables: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, unknown>>>> = {};
    for (const [group, entries] of Object.entries(declared)) {
      const table: Record<string, (input: unknown) => Promise<Result<unknown, unknown>>> = {};
      for (const [name, entry] of Object.entries(entries)) {
        // Erase only heterogeneous test dispatch; all builders satisfy the public contracts.
        const command = entry as Detail<(input: unknown) => Promise<Result<unknown, unknown>>>;
        table[name] = async input => {
          const operation = `${group}.${name}`, id = `procurement.${namespaces[group]}.v1.${name}`;
          const before = snapshot(), original = structuredClone(input), attemptsBefore = commitAttempts, realBefore = realCommits, start = calls.length;
          preflight = true;
          try { assert.deepEqual((await command.runDetailed(input)).result, err({ kind: 'Conflict' }), operation); }
          finally { preflight = false; }
          const timeline = calls.slice(start);
          assert.equal(timeline.filter(event => event.method === 'read').length, readCounts[operation], operation);
          assert.equal(timeline.filter(event => event.method === 'related').length, relatedCounts[operation], operation);
          assert.equal(timeline.filter(event => event.method === 'commit').length, 1); assert.equal(timeline.at(-1)?.method, 'commit');
          assert.deepEqual(snapshot(), before); assert.equal(commitAttempts, attemptsBefore + 1); assert.equal(realCommits, realBefore);
          for (const [index, target] of timeline.entries()) for (const delivery of ['throw', 'reject'] as const) {
            const cause = new Error('private-storage-exception'), events: Event[] = [];
            const from = calls.length, attempted = commitAttempts, deliveredBefore = delivered;
            armed = { left: index + 1, cause, delivery };
            try {
              await assert.rejects(command.runDetailed(input, {
                input: (_value, step) => { inputSelections++; events.push({ phase: 'input', step }); if (mode === 'input-failure') throw Error('private-selection-exception'); return null; },
                result: (result, step) => { resultSelections++; events.push({ phase: 'result', step, ok: result.ok }); if (mode === 'result-failure') throw Error('private-selection-exception'); return result.ok; },
              }), error => error === cause, `repository exception was replaced at ${operation}`);
            } finally { armed = undefined; }
            assert.equal(delivered, deliveredBefore + 1);
            assert.deepEqual(calls.slice(from), timeline.slice(0, index + 1), `exception continued IO at ${operation}`);
            assert.equal(commitAttempts, attempted + (target.method === 'commit' ? 1 : 0)); assert.equal(realCommits, realBefore);
            assert.deepEqual(snapshot(), before, `exception changed persisted models at ${operation}`);
            const steps = target.method === 'commit' ? [`${id}:load`, 'run:1', ...(split.has(operation) ? ['run:2'] : []), id] : [`${id}:load`];
            const expected: Event[] = steps.flatMap((step, at) => [
              { phase: 'input' as const, step },
              ...(at < steps.length - 1 && mode !== 'input-failure' ? [{ phase: 'result' as const, step, ok: true }] : []),
            ]);
            assert.deepEqual(events, expected); assert(!JSON.stringify(events).includes('private-storage-exception'));
            cases.push({ operation, at: index + 1, delivery, events });
          }
          const validStart = calls.length, success = await command.runDetailed(input);
          assert(success.result.ok, operation); assert.deepEqual(calls.slice(validStart), timeline);
          assert.equal(commitAttempts, attemptsBefore + 4); assert.equal(realCommits, realBefore + 1);
          assert.deepEqual(input, original); return success.result;
        };
      }
      tables[group] = table;
    }
    return tables as StudyCommands;
  };
  try {
    const outcome = await story(wrapped, tracked);
    assert.equal(realCommits, 32); assert.equal(commitAttempts, 128); assert.equal(delivered, 178); assert.equal(cases.length, 178);
    const positions = operations.flatMap(name => Array.from({ length: readCounts[name]! + relatedCounts[name]! + 1 }, (_, index) => `${name}#${index + 1}`)).sort();
    assert.equal(positions.length, 72);
    for (const delivery of ['throw', 'reject']) {
      const selected = cases.filter(item => item.delivery === delivery); assert.equal(selected.length, 89);
      assert.deepEqual([...new Set(selected.map(item => `${item.operation}#${item.at}`))].sort(), positions);
    }
    assert.equal(inputSelections, 334); assert.equal(resultSelections, mode === 'input-failure' ? 0 : 156);
    return { outcome, calls, cases, realCommits, commitAttempts };
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
}
async function ordinary(backend: string) {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  try { return await story(plainProcurement, repository); }
  finally { if (repository instanceof SqliteProcurement) repository.close(); }
}
for (const backend of ['memory', 'sqlite']) for (const mode of ['selected', 'input-failure', 'result-failure'] as const) {
  test(`all exercised IO exceptions retain identity and stop without a fabricated report: ${backend}/${mode}`, async () => {
    const expected = await ordinary(backend), reference = await run(builders.plain!, backend, mode);
    assert.deepEqual(reference.outcome, expected);
    for (const name of ['helper', 'koyuki']) {
      const actual = await run(builders[name]!, backend, mode);
      assert.deepEqual(actual, reference); assert.deepEqual(actual.outcome, expected);
    }
  });
}
test('the comparison rejects a loader that silently converts unexpected exceptions into Result errors', async () => {
  const converting: Factory = (port, identity, policy) => builders.koyuki!({ ...port,
    read: async (kind, id, actor) => { try { return await port.read(kind, id, actor); } catch { return err({ kind: 'Conflict' }); } },
  }, identity, policy);
  await assert.rejects(run(converting, 'memory', 'selected'), /repository exception was replaced at requests.edit/);
});
