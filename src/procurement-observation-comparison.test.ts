import type { ActionReport, WorkflowCapture, ObservationReport } from './framework/index.js';
import type { CreateInput, Request, RuleError } from './experiments/procurement/domain.js';
import type { StorageError } from './experiments/procurement/repository.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { procurement } from './experiments/procurement/application.js';
import { plainProcurement } from './experiments/procurement/plain.js';
import { helperProcurement } from './experiments/procurement/helper.js';
import { baselineDetail } from './experiments/procurement/baseline-detail.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
const actor = { id: 'buyer', role: 'buyer' as const, groupId: 'g1', active: true };
const policy = { requestLimitCents: 1000, approverIds: ['approver'] };
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500, privateText: 'private-input-123', fn: () => 1 }] };
type ObservedCommand = { runDetailed: {
  (input: CreateInput): Promise<ActionReport<Request, RuleError | StorageError>>;
  <I, R>(input: CreateInput, capture: WorkflowCapture<I, R>): Promise<ActionReport<Request, RuleError | StorageError> & ObservationReport<I, R>>;
} };
type Builder = (repository: MemoryProcurement) => { requests: { create: ObservedCommand } };
const builders: Record<'koyuki' | 'plain' | 'helper', Builder> = {
  koyuki: (repository: MemoryProcurement) => procurement(repository, actor, policy),
  plain: (repository: MemoryProcurement) => baselineDetail(plainProcurement, repository, actor, policy),
  helper: (repository: MemoryProcurement) => baselineDetail(helperProcurement, repository, actor, policy),
};
async function selected(build: Builder) {
  const repository = new MemoryProcurement(), selected = { label: 'selected-before-clone' };
  const report = await build(repository).requests.create.runDetailed(input, { input: () => selected, result: result => result.ok });
  selected.label = 'changed-after-report';
  assert(report.result.ok); assert.equal(repository.commits, 1);
  assert.equal(report.observations.length, 5); assert.deepEqual(report.observationErrors, []);
  assert(report.observations.every(entry => entry.input.label === 'selected-before-clone'));
  assert(!JSON.stringify(report).includes('private-input-123'));
  assert(Object.isFrozen(report.observations)); assert(Object.isFrozen(report.observations[0]));
  const label: string = report.observations[0]!.input.label; const success: boolean = report.observations[0]!.result;
  void [label, success]; return report;
}
async function captureFailures(build: Builder) {
  const repository = new MemoryProcurement(), commands = build(repository); let resultCalls = 0;
  const inputFailure = await commands.requests.create.runDetailed(input, {
    input: () => { throw new Error('private-capture-error'); }, result: () => { resultCalls++; return true; },
  });
  assert(inputFailure.result.ok); assert.equal(resultCalls, 0); assert.equal(inputFailure.observations.length, 0); assert.equal(inputFailure.observationErrors.length, 5);
  assert(!JSON.stringify(inputFailure.observationErrors).includes('private-capture-error'));
  const resultFailure = await commands.requests.create.runDetailed({ ...input, id: 'second' }, {
    input: () => null, result: (_result, step) => step === 'procurement.request.v1.create' ? () => 'not-cloneable' : true,
  });
  assert(resultFailure.result.ok); assert.equal(resultFailure.observations.length, 4);
  assert.deepEqual(resultFailure.observationErrors, [{ step: 'procurement.request.v1.create', phase: 'result', kind: 'CaptureFailed' }]);
  assert.equal(repository.commits, 2); assert.equal(repository.list('request', actor).length, 2);
  return { inputFailure, resultFailure };
}
async function failedRule(build: Builder) {
  const repository = new MemoryProcurement();
  const report = await build(repository).requests.create.runDetailed({ id: 'bad', lines: [] }, { input: () => 'selected', result: result => result.ok ? 'ok' : 'failed' });
  assert.deepEqual(report.result, { ok: false, error: { kind: 'InvalidInput' } });
  assert.equal(report.observations.length, 3); assert.equal(repository.commits, 0);
  assert.equal(report.observations.at(-1)?.result, 'failed'); return report;
}
async function concurrent(build: Builder) {
  const repository = new MemoryProcurement(), commands = build(repository);
  const reports = await Promise.all(['a', 'b'].map(id => commands.requests.create.runDetailed({ ...input, id }, { input: () => id, result: result => result.ok })));
  for (let index = 0; index < reports.length; index++) assert(reports[index]!.observations.every(entry => entry.input === ['a', 'b'][index]));
  assert.equal(repository.commits, 2); return reports;
}
for (const [name, build] of Object.entries(builders)) {
  test(`selected values precede clone and remain isolated: ${name}`, async () => assert.deepEqual(await selected(build), await selected(builders.koyuki)));
  test(`capture failures cannot alter saved business results: ${name}`, async () => assert.deepEqual(await captureFailures(build), await captureFailures(builders.koyuki)));
  test(`failed rule observations stop before save: ${name}`, async () => assert.deepEqual(await failedRule(build), await failedRule(builders.koyuki)));
  test(`concurrent captures belong to each invocation: ${name}`, async () => assert.deepEqual(await concurrent(build), await concurrent(builders.koyuki)));
}
