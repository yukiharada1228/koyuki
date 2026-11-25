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
const operations = [
  'requests.create', 'requests.edit', 'requests.submit', 'requests.withdraw', 'requests.approve', 'requests.reject', 'requests.return', 'requests.reassign',
  'orders.place', 'orders.amend', 'orders.cancel', 'orders.complete', 'receipts.receive', 'receipts.return', 'receipts.correct',
  'invoices.register', 'invoices.match', 'invoices.approve', 'invoices.void', 'payments.record', 'payments.cancel',
  'inventory.reserve', 'inventory.release', 'inventory.move', 'inventory.adjust',
].sort();
const split = new Set(['requests.edit', 'requests.withdraw', 'requests.reject', 'requests.return', 'requests.reassign',
  'orders.amend', 'orders.cancel', 'orders.complete', 'invoices.approve', 'invoices.void', 'receipts.receive', 'receipts.return', 'receipts.correct']);
const namespaces: Record<string, string> = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' };
type Mode = 'selected' | 'input-failure' | 'result-failure';
async function run(build: Factory, backend: string, mode: Mode, persistOnConflict = false) {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  const reads: { method: string; kind: string; id: string }[] = [];
  const reports: { operation: string; failure: 'invalid' | 'save-conflict'; report: ActionReport<unknown, unknown> & ObservationReport<null, boolean> }[] = [];
  let commits = 0, rejectCommit = false, inputSelections = 0, resultSelections = 0;
  const tracked: Inspectable = {
    read: (kind, id, identity) => { reads.push({ method: 'read', kind, id }); return repository.read(kind, id, identity); },
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
          const readSets: typeof reads[] = [];
          for (const failure of ['invalid', 'save-conflict'] as const) {
            const start = reads.length, selectionsBefore = [inputSelections, resultSelections];
            rejectCommit = failure === 'save-conflict';
            let report: ActionReport<unknown, unknown> & ObservationReport<null, boolean>;
            try {
              report = await command.runDetailed(failure === 'invalid' ? invalid : input, {
                input: () => { inputSelections++; if (mode === 'input-failure') throw Error('private-selection-error'); return null; },
                result: result => { resultSelections++; if (mode === 'result-failure') throw Error('private-selection-error'); return result.ok; },
              });
            } finally { rejectCommit = false; }
            const steps = failure === 'invalid' ? [`${id}:load`, 'run:1'] : [`${id}:load`, 'run:1', ...(split.has(operation) ? ['run:2'] : []), id];
            assert.deepEqual(report.result, err({ kind: failure === 'invalid' ? 'InvalidInput' : 'Conflict' }), operation);
            assert.deepEqual(report.trace, steps.map((step, index) => ({ step, status: index === steps.length - 1 ? 'error' : 'ok' })), operation);
            if (failure === 'invalid') assert.equal(report.plan, null);
            else {
              const plan = report.plan;
              assert(plan && typeof plan === 'object' && 'kind' in plan && 'operation' in plan);
              assert.equal(plan.kind, 'write'); assert.equal(plan.operation, id);
            }
            assert.equal(commits, beforeCommits + (failure === 'save-conflict' ? 1 : 0), operation);
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
            readSets.push(reads.slice(start)); reports.push({ operation, failure, report });
          }
          const start = reads.length;
          const success = await command.runDetailed(input);
          assert(success.result.ok, operation); assert.equal(commits, beforeCommits + 2);
          // Both rejection attempts load once, with the same targets as the valid call.
          for (const readSet of readSets) assert.deepEqual(readSet, reads.slice(start), operation);
          assert.deepEqual(input, original); return success.result;
        };
      }
      tables[group] = table;
    }
    return tables as StudyCommands;
  };
  try {
    const outcome = await story(wrapped, tracked);
    assert.equal(commits, 64); assert.equal(reports.length, 64);
    assert.deepEqual([...new Set(reports.map(row => row.operation))].sort(), operations);
    assert.equal(inputSelections, 174); assert.equal(resultSelections, mode === 'input-failure' ? 0 : 174);
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
