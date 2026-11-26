import test from 'node:test';
import assert from 'node:assert/strict';
import { business, step, workflow, withInput, ok, err, type Result } from './framework/index.js';
import { createRequest, checkBuyerRequest, checkRequestEdit, parseRequestLines, requestEditPlan, editRequest,
  type CheckedRequest, type Loaded, type EditInput, type Request, type Draft, type RuleError, type ParsedRequestLines } from './experiments/procurement/domain.js';
import { parsedRequestInput, editPlan } from './experiments/procurement/request-pipeline.js';
import { procurement } from './experiments/procurement/application.js';
import { actor, policy } from './experiments/procurement/comparison-scenario.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import type { StorageError } from './experiments/procurement/repository.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
// Previous composition retained only as a comparison harness, outside production.
const requestEditDecision = workflow('require-draft', checkRequestEdit)
  .then('parse-lines', withInput(value => parseRequestLines(value.input.lines)))
  .then('edit-request-plan', ({ input, value }) => ok(requestEditPlan(input, value)));
const originalInput = { id: 'rq', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }] };
const input = { id: 'rq', expectedVersion: 1, lines: [{ sku: 'b', quantity: 2, unitCents: 75 }] };
const expected = {
  result: { kind: 'request', state: 'draft', id: 'rq', groupId: 'g1', ownerId: 'buyer', version: 2, lines: input.lines, totalCents: 150 },
  writes: [{ kind: 'request', state: 'draft', id: 'rq', groupId: 'g1', ownerId: 'buyer', version: 2, lines: input.lines, totalCents: 150 }],
  checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 1 }],
};

test('request edit retains checked context and produces the independent next-version plan', () => {
  const created = createRequest({ input: originalInput, actor: actor('buyer') }); assert(created.ok);
  const raw = { input, current: created.value.result, actor: actor('buyer') }, before = structuredClone(raw);
  const checked = checkBuyerRequest(raw); assert(checked.ok);
  const editable = checkRequestEdit(checked.value), parsed = parseRequestLines(input.lines); assert(editable.ok && parsed.ok);
  assert.strictEqual(editable.value, raw); assert.deepEqual(requestEditPlan(editable.value, parsed.value), expected);
  assert.deepEqual(requestEditDecision.inspect(checked.value), { result: ok(expected), trace: [
    { step: 'require-draft', status: 'ok' }, { step: 'parse-lines', status: 'ok' }, { step: 'edit-request-plan', status: 'ok' },
  ] });
  assert.deepEqual(editRequest(raw), ok(expected)); assert.deepEqual(raw, before);
});

test('authorization/version errors retain priority without reading lines', () => {
  const created = createRequest({ input: originalInput, actor: actor('buyer') }); assert(created.ok);
  let reads = 0;
  const protectedInput = { id: 'rq', expectedVersion: -1, get lines() { reads++; throw Error('must not parse'); } };
  assert.deepEqual(editRequest({ input: protectedInput, current: created.value.result, actor: actor('buyer') }), err({ kind: 'InvalidInput' }));
  const denied = checkBuyerRequest({ input: protectedInput, current: created.value.result, actor: actor('buyer', 'other') });
  assert.deepEqual(denied, err({ kind: 'Denied' }));
  assert.deepEqual(checkBuyerRequest({ input: { id: 'rq', expectedVersion: 2, lines: [] }, current: created.value.result, actor: actor('buyer') }), err({ kind: 'Conflict' }));
  assert.equal(reads, 0);
});

for (const backend of ['memory', 'sqlite']) test(`edit rejects wrong state/lines without save and preserves version semantics: ${backend}`, async () => {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  let saves = 0;
  const commands = procurement({ read: repository.read.bind(repository), related: repository.related.bind(repository),
    commit: (change, identity) => { saves++; return repository.commit(change, identity); },
  }, actor('buyer'), policy);
  type Input = Assert<Equal<Parameters<typeof commands.requests.edit>[0], EditInput>>;
  type Output = Assert<Equal<Extract<Awaited<ReturnType<typeof commands.requests.edit>>, { ok: true }>['value'], Draft>>;
  try {
    assert((await commands.requests.create(originalInput)).ok); assert.equal(saves, 1);
    const before = repository.list('request', actor('buyer'));
    const failed = await commands.requests.edit.runDetailed({ ...input, lines: [] });
    assert.deepEqual(failed.result, err({ kind: 'InvalidInput' })); assert.equal(failed.plan, null);
    assert.deepEqual(failed.trace.map(row => row.step), ['procurement.request.v1.edit:load', 'run:1', 'require-draft', 'parse-lines']);
    assert.equal(saves, 1); assert.deepEqual(repository.list('request', actor('buyer')), before);
    assert.deepEqual(await commands.requests.edit(input), ok(expected.result)); assert.equal(saves, 2);
    assert((await commands.requests.submit({ id: 'rq', expectedVersion: 2, approverId: 'approver' })).ok); assert.equal(saves, 3);
    const submitted = repository.list('request', actor('buyer'))[0]!;
    let reads = 0;
    const protectedInput = { id: 'rq', expectedVersion: 3, get lines() { reads++; throw Error('must not parse'); } };
    const checked = checkBuyerRequest({ input: protectedInput, actor: actor('buyer'), current: submitted }); assert(checked.ok);
    assert.deepEqual(requestEditDecision.inspect(checked.value), { result: err({ kind: 'WrongState' }), trace: [{ step: 'require-draft', status: 'error' }] });
    assert.equal(reads, 0);
    assert.deepEqual((await commands.requests.edit.runDetailed({ id: 'rq', expectedVersion: 3, lines: [] })).result, err({ kind: 'WrongState' }));
    assert.deepEqual(await commands.requests.edit({ id: 'rq', expectedVersion: 99, lines: [] }), err({ kind: 'Conflict' }));
    assert.equal(saves, 3); assert.deepEqual(repository.list('request', actor('buyer')), [submitted]);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts(value: CheckedRequest<Loaded<EditInput, Request>, 'buyer'>, parsed: ParsedRequestLines, raw: Loaded<EditInput, Request>) {
  // @ts-expect-error ordinary context does not prove buyer authorization
  checkRequestEdit(raw);
  // @ts-expect-error a checked request of arbitrary state does not prove it is editable
  requestEditPlan(value, parsed);
  const editable = checkRequestEdit(value);
  if (editable.ok) {
    requestEditPlan(editable.value, parsed);
    // @ts-expect-error raw empty lines do not provide the parsed-collection proof
    requestEditPlan(editable.value, []);
  }
}
void typeContracts;

test('shared line parsing retains the editable state proof and extra context', () => {
  const created = createRequest({ input: originalInput, actor: actor('buyer') }); assert(created.ok);
  const checked = checkBuyerRequest({ input, current: created.value.result, actor: actor('buyer') }); assert(checked.ok);
  const editable = checkRequestEdit(checked.value); assert(editable.ok);
  const context = { ...editable.value, correlationId: 'edit' as const }, parsed = parsedRequestInput(context);
  type Exact = Assert<Equal<typeof parsed, Result<Readonly<{ input: typeof context; value: ParsedRequestLines }>, Readonly<{ kind: 'InvalidInput' }>>>>;
  assert(parsed.ok); assert(Object.isFrozen(parsed.value)); assert.strictEqual(parsed.value.input, context);
  assert.equal(parsed.value.input.correlationId, 'edit'); assert.deepEqual(editPlan(parsed.value), ok(expected));
});

function unguardedEdit(value: CheckedRequest<Loaded<EditInput, Request>, 'buyer'>) {
  const load = async (_id: string) => ok(value), save = async (change: ReturnType<typeof requestEditPlan>) => ok(change.result);
  // @ts-expect-error buyer authorization cannot replace the omitted draft-state check
  business({ name: 'unguarded-edit', load, save, operations: { edit: [step('parse-lines', parsedRequestInput), step('edit-plan', editPlan)] } });
  const parsed = parsedRequestInput(value);
  if (parsed.ok) {
    // @ts-expect-error buyer authorization and parsed lines do not prove draft state
    editPlan(parsed.value);
  }
}
void unguardedEdit;
