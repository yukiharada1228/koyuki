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
import type { StudyCommands, StudyFactory } from './experiments/procurement/comparison-contract.js';
import type { Actor, Policy } from './experiments/procurement/domain.js';
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
import { operations, ruleSteps, readCounts } from './experiments/procurement/failure-testing.js';
const namespaces: Record<string, string> = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' };
type Mode = 'selected' | 'input-failure' | 'result-failure';
type Failure = 'load-sync' | 'load-async' | 'invalid' | 'save-conflict';
async function run(build: Factory, backend: string, mode: Mode, persistOnConflict = false) {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  const reads: { method: string; kind: string; id: string }[] = [];
  const reports: { operation: string; failure: Failure; readAt?: number; report: ActionReport<unknown, unknown> & ObservationReport<null, boolean> }[] = [];
  let commits = 0, rejectCommit = false, inputSelections = 0, resultSelections = 0, rejectedReads = 0;
  let rejectRead: 'sync' | 'async' | undefined;
  let rejectReadAt = 0;
  const tracked: Inspectable = {
    read: (kind, id, identity) => {
      reads.push({ method: 'read', kind, id });
      if (rejectRead && --rejectReadAt === 0) {
        const delivery = rejectRead; rejectRead = undefined; rejectedReads++;
        const rejected = err({ kind: 'Conflict' as const });
        return delivery === 'sync' ? rejected : Promise.resolve(rejected);
      }
      return repository.read(kind, id, identity);
    },
    related: (kind, id, identity) => { reads.push({ method: 'related', kind, id }); return repository.related(kind, id, identity); },
    list: repository.list.bind(repository),
    commit: async (change, identity) => {
      commits++;
      if (rejectCommit) {
        // The normal injection is strictly before the real adapter commit.
        // This optional mutant deliberately violates that contract to test the oracle.
        if (persistOnConflict) await repository.commit(change, identity);
        return err({ kind: 'Conflict' });
      }
      return repository.commit(change, identity);
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
        // Each builder is type-checked against all 25 public contracts above.
        // Only heterogeneous test dispatch and invalid DTO construction are erased.
        const command = entry as Detail<(input: unknown) => Promise<Result<unknown, unknown>>>;
        table[name] = async input => {
          assert(input && typeof input === 'object' && !Array.isArray(input));
          const operation = `${group}.${name}`, id = `procurement.${namespaces[group]}.v1.${name}`;
          const original = structuredClone(input);
          const invalid = group === 'requests' && name === 'create' ? { ...original, lines: [] } : { ...original, expectedVersion: -1 };
          const before = snapshot(), beforeCommits = commits;
          const readSets: { failure: Failure; prefixLength?: number; calls: typeof reads }[] = [];
          // Creating a request only prepares input/identity; it performs no read.
          // First record the complete load with a rejected save, then derive the
          // finite read positions. Check their count against the fixed topology.
          const failures: { failure: Failure; readAt?: number; prefixLength?: number }[] = [{ failure: 'save-conflict' }, { failure: 'invalid' }];
          for (const spec of failures) {
            const { failure } = spec;
            const loadFailure = failure === 'load-sync' || failure === 'load-async';
            const start = reads.length, readsBefore = rejectedReads, attemptCommits = commits, selectionsBefore = [inputSelections, resultSelections];
            rejectRead = failure === 'load-sync' ? 'sync' : failure === 'load-async' ? 'async' : undefined;
            rejectReadAt = spec.readAt ?? 0;
            rejectCommit = failure === 'save-conflict';
            let report: ActionReport<unknown, unknown> & ObservationReport<null, boolean>;
            try {
              report = await command.runDetailed(failure === 'invalid' ? invalid : input, {
                input: () => { inputSelections++; if (mode === 'input-failure') throw Error('private-selection-error'); return null; },
                result: result => { resultSelections++; if (mode === 'result-failure') throw Error('private-selection-error'); return result.ok; },
              });
            } finally { rejectCommit = false; rejectRead = undefined; }
            const steps = loadFailure ? [`${id}:load`] : failure === 'invalid' ? [`${id}:load`, ...(operation === 'requests.create' ? ['authorize-creation', 'parse-lines'] : ['run:1'])] : [`${id}:load`, ...ruleSteps(operation), id];
            assert.deepEqual(report.result, err({ kind: failure === 'invalid' ? 'InvalidInput' : 'Conflict' }), operation);
            assert.deepEqual(report.trace, steps.map((step, index) => ({ step, status: index === steps.length - 1 ? 'error' : 'ok' })), operation);
            if (failure !== 'save-conflict') assert.equal(report.plan, null);
            else {
              const plan = report.plan;
              assert(plan && typeof plan === 'object' && 'kind' in plan && 'operation' in plan);
              assert.equal(plan.kind, 'write'); assert.equal(plan.operation, id);
            }
            assert.equal(commits, attemptCommits + (failure === 'save-conflict' ? 1 : 0), operation);
            assert.equal(rejectedReads - readsBefore, loadFailure ? 1 : 0, operation);
            if (loadFailure) {
              assert.equal(reads.length - start, spec.prefixLength, `load failure continued repository calls at ${operation}`);
              assert.equal(reads.at(-1)?.method, 'read', operation);
            }
            assert.deepEqual(snapshot(), before, `${failure} changed persisted models at ${operation}`);
            if (mode === 'selected') {
              assert.deepEqual(report.observationErrors, []);
              assert.deepEqual(report.observations, steps.map((step, index) => ({ step, input: null, result: index < steps.length - 1 })));
            } else {
              assert.deepEqual(report.observations, []);
              assert.deepEqual(report.observationErrors, steps.map(step => ({ step, phase: mode === 'input-failure' ? 'input' : 'result', kind: 'CaptureFailed' })));
              assert(!JSON.stringify(report.observationErrors).includes('private-selection-error'));
            }
            assert.equal(inputSelections - selectionsBefore[0]!, steps.length);
            assert.equal(resultSelections - selectionsBefore[1]!, mode === 'input-failure' ? 0 : steps.length);
            assert(Object.isFrozen(report.observations));
            const calls = reads.slice(start);
            readSets.push({ failure, prefixLength: spec.prefixLength, calls });
            reports.push({ operation, failure, ...(spec.readAt === undefined ? {} : { readAt: spec.readAt }), report });
            if (failure === 'save-conflict') {
              assert.equal(calls.filter(call => call.method === 'read').length, readCounts[operation], operation);
              let readAt = 0;
              for (const [index, call] of calls.entries()) if (call.method === 'read') {
                readAt++;
                failures.push({ failure: 'load-sync', readAt, prefixLength: index + 1 }, { failure: 'load-async', readAt, prefixLength: index + 1 });
              }
            }
          }
          const start = reads.length;
          const success = await command.runDetailed(input);
          assert(success.result.ok, operation); assert.equal(commits, beforeCommits + 2);
          const validReads = reads.slice(start);
          if (operation === 'requests.create') assert.deepEqual(validReads, []);
          for (const readSet of readSets) {
            const loadFailure = readSet.failure === 'load-sync' || readSet.failure === 'load-async';
            assert.deepEqual(readSet.calls, loadFailure ? validReads.slice(0, readSet.prefixLength) : validReads, operation);
          }
          assert.deepEqual(input, original); return success.result;
        };
      }
      tables[group] = table;
    }
    return tables as StudyCommands;
  };
  try {
    const outcome = await story(wrapped, tracked);
    assert.equal(commits, 64); assert.equal(reports.length, 142); assert.equal(rejectedReads, 78);
    assert.deepEqual([...new Set(reports.map(row => row.operation))].sort(), operations);
    for (const failure of ['load-sync', 'load-async'] as const) {
      const selected = reports.filter(row => row.failure === failure);
      assert.equal(selected.length, 39);
      assert.deepEqual([...new Set(selected.map(row => row.operation))].sort(), operations.filter(name => name !== 'requests.create'));
      const positions = operations.flatMap(name => Array.from({ length: readCounts[name]! }, (_, index) => `${name}#${index + 1}`)).sort();
      assert.equal(positions.length, 32);
      assert.deepEqual([...new Set(selected.map(row => `${row.operation}#${row.readAt}`))].sort(), positions);
    }
    assert.equal(inputSelections, 272); assert.equal(resultSelections, mode === 'input-failure' ? 0 : 272);
    return { outcome, reports, reads, commits };
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
}
async function ordinary(backend: string) {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  try { return await story(plainProcurement, repository); }
  finally { if (repository instanceof SqliteProcurement) repository.close(); }
}
for (const backend of ['memory', 'sqlite']) for (const mode of ['selected', 'input-failure', 'result-failure'] as const) {
  test(`all 25 operations preserve representative rejections and observations: ${backend}/${mode}`, async () => {
    const expected = await ordinary(backend), reference = await run(builders.plain!, backend, mode);
    assert.deepEqual(reference.outcome, expected);
    for (const name of ['helper', 'koyuki']) {
      const actual = await run(builders[name]!, backend, mode);
      assert.deepEqual(actual, reference); assert.deepEqual(actual.outcome, expected);
    }
  });
}
test('the comparison detects an adapter that writes before returning the injected Conflict', async () => {
  await assert.rejects(run(builders.koyuki!, 'memory', 'selected', true), /save-conflict changed persisted models at requests.create/);
});
test('the comparison detects extra repository calls even when the loader returns the correct Conflict', async () => {
  const continuing: Factory = (port, identity, policy) => builders.koyuki!({ ...port,
    read: async (kind, id, actor) => {
      const result = await port.read(kind, id, actor);
      if (!result.ok) await port.related('receipt', id, actor);
      return result;
    },
  }, identity, policy);
  await assert.rejects(run(continuing, 'memory', 'selected'), /load failure continued repository calls at requests.edit/);
});
