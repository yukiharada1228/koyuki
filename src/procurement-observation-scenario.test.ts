import test from 'node:test';
import assert from 'node:assert/strict';
import type { Result, ActionReport, WorkflowCapture, ObservationReport } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { baselineDetail } from './experiments/procurement/baseline-detail.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { story, type Inspectable } from './experiments/procurement/comparison-scenario.js';
import type { StudyCommands, StudyFactory } from './experiments/procurement/comparison-contract.js';
import type { Actor, Policy } from './experiments/procurement/domain.js';

type Subject = { kind: string | null; id: string | null; state: string | null; version: number | null };
type SelectedInput = { invocation: number; subject: Subject };
type SelectedResult = { ok: boolean; subject: Subject | null };
type Captured = ObservationReport<SelectedInput, SelectedResult>;
type Detail<C> = C extends (input: infer I) => Promise<Result<infer O, infer E>> ? {
  runDetailed(input: I, capture: WorkflowCapture<SelectedInput, SelectedResult>): Promise<ActionReport<O, E> & Captured>;
} : never;
type DetailedCommands = { [G in keyof StudyCommands]: { [K in keyof StudyCommands[G]]: Detail<StudyCommands[G][K]> } };
type Factory = (repository: ProcurementRepository, actor: Actor, policy: Policy) => DetailedCommands;
const builders: Record<string, Factory> = {
  koyuki: procurement,
  plain: (repository, actor, policy) => baselineDetail(plainProcurement, repository, actor, policy),
  helper: (repository, actor, policy) => baselineDetail(helperProcurement, repository, actor, policy),
};
// Scenario-owned plain data only. Select entity metadata, never actor or arbitrary fields.
function subject(value: unknown): Subject {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const unwrapped = record.input && record.value && typeof record.value === 'object' ? record.value as Record<string, unknown> : record;
  const selected = unwrapped.current ?? unwrapped.result ?? unwrapped;
  const entity = selected && typeof selected === 'object' ? selected as Record<string, unknown> : {};
  return { kind: typeof entity.kind === 'string' ? entity.kind : null, id: typeof entity.id === 'string' ? entity.id : null,
    state: typeof entity.state === 'string' ? entity.state : null, version: typeof entity.version === 'number' ? entity.version : null };
}
type Mode = 'selected' | 'input-failure' | 'result-failure';
async function run(build: Factory | undefined, backend: string, mode: Mode = 'selected') {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  let commits = 0, invocations = 0, resultProjections = 0;
  const reads: { method: 'read' | 'related'; kind: string; id: string }[] = [];
  const reports: { operation: string; report: ActionReport<unknown, unknown> & Captured }[] = [];
  const tracked: Inspectable = {
    read: (kind, id, actor) => { reads.push({ method: 'read', kind, id }); return repository.read(kind, id, actor); },
    related: (kind, id, actor) => { reads.push({ method: 'related', kind, id }); return repository.related(kind, id, actor); },
    list: repository.list.bind(repository),
    commit: async (change, actor) => { commits++; return repository.commit(change, actor); } };
  const observed: StudyFactory = (repository, actor, policy) => {
    assert(build); const declared = build(repository, actor, policy);
    const tables: Record<string, Record<string, (input: unknown) => Promise<Result<unknown, unknown>>>> = {};
    for (const [group, entries] of Object.entries(declared)) {
      const table: Record<string, (input: unknown) => Promise<Result<unknown, unknown>>> = {};
      // Only heterogeneous runtime key dispatch is erased; each builder above must
      // satisfy all 25 public input/result/detail signatures before this boundary.
      for (const [name, entry] of Object.entries(entries)) {
        const command = entry as Detail<(input: unknown) => Promise<Result<unknown, unknown>>>;
        table[name] = async input => {
          const invocation = ++invocations, beforeCommits = commits;
          const report = await command.runDetailed(input, {
            input: value => { if (mode === 'input-failure') throw Error('private-observation-failure'); return { invocation, subject: subject(value) }; },
            result: result => { resultProjections++; if (mode === 'result-failure') throw Error('private-observation-failure'); return { ok: result.ok, subject: result.ok ? subject(result.value) : null }; },
          });
          assert.equal(commits, beforeCommits + 1);
          const namespaces: Record<string, string> = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' };
          const operation = `procurement.${namespaces[group]}.v1.${name}`;
          const splitRule = group === 'orders' && ['place', 'amend', 'cancel', 'complete'].includes(name)
            || group === 'requests' && ['edit', 'withdraw', 'reject', 'return', 'reassign', 'submit', 'approve'].includes(name)
            || group === 'invoices' && ['approve', 'void'].includes(name)
            || group === 'receipts' || group === 'inventory';
          const expectedRules = group === 'requests' && name === 'create' ? ['authorize-creation', 'parse-lines', 'create-request-plan'] : group === 'receipts' && name === 'correct' ? ['run:1', 'revalidate-correction', 'correct-receipt-plan', 'run:3'] : ['run:1', ...(splitRule ? ['run:2'] : []), ...(group === 'receipts' && name === 'return' ? ['run:3'] : [])];
          const expectedSteps = [`${operation}:load`, ...expectedRules, operation];
          assert.deepEqual(report.trace, expectedSteps.map(step => ({ step, status: 'ok' })));
          if (mode !== 'selected') {
            assert.deepEqual(report.observations, []);
            assert.equal(report.observationErrors.length, expectedSteps.length);
            assert.deepEqual(report.observationErrors, report.trace.map(row => ({ step: row.step, phase: mode === 'input-failure' ? 'input' : 'result', kind: 'CaptureFailed' })));
            assert(!JSON.stringify(report.observationErrors).includes('private-observation-failure'));
          } else {
            assert.deepEqual(report.observationErrors, []); assert.equal(report.observations.length, expectedSteps.length);
            assert(report.observations.every(row => row.input.invocation === invocation && row.result.ok));
            assert.deepEqual(report.observations.at(-1)?.result.subject, report.result.ok ? subject(report.result.value) : null);
            const saved = report.observations.at(-1)?.result.subject;
            assert(saved?.kind && saved.id && saved.version !== null && saved.version >= 1);
            assert(Object.isFrozen(report.observations)); assert(Object.isFrozen(report.observations[0]));
          }
          reports.push({ operation: `${group}.${name}`, report }); return report.result;
        };
      }
      tables[group] = table;
    }
    return tables as StudyCommands;
  };
  try {
    const outcome = await story(build ? observed : plainProcurement, tracked);
    assert.equal(commits, 32);
    if (build) {
      assert.equal(reports.length, 32); assert.equal(new Set(reports.map(row => row.operation)).size, 25);
      assert.equal(resultProjections, mode === 'input-failure' ? 0 : 128);
    }
    return { outcome, reports, commits, reads };
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
}

for (const backend of ['memory', 'sqlite']) for (const [name, build] of Object.entries(builders)) {
  test(`all 25 operations preserve selected observations and saved results: ${name}/${backend}`, async () => {
    const ordinary = await run(undefined, backend);
    const observed = await run(build, backend);
    const failed = await run(build, backend, 'input-failure');
    const failedResult = await run(build, backend, 'result-failure');
    assert.deepEqual(observed.outcome, ordinary.outcome); assert.deepEqual(failed.outcome, ordinary.outcome);
    assert.deepEqual(failedResult.outcome, ordinary.outcome);
    assert.deepEqual(observed.reads, ordinary.reads); assert.deepEqual(failed.reads, ordinary.reads); assert.deepEqual(failedResult.reads, ordinary.reads);
    const reference = name === 'plain' ? observed : await run(builders.plain, backend);
    assert.deepEqual(observed, reference);
    const failedReference = name === 'plain' ? failed : await run(builders.plain, backend, 'input-failure');
    assert.deepEqual(failed, failedReference);
    const failedResultReference = name === 'plain' ? failedResult : await run(builders.plain, backend, 'result-failure');
    assert.deepEqual(failedResult, failedResultReference);
  });
}
