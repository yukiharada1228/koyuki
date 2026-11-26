import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result } from './framework/index.js';
import { checkRequestCreation, parseRequestLines, requestCreationPlan, createRequest, type CreateInput, type Draft, type RuleError } from './experiments/procurement/domain.js';
import { requestCreationDecision } from './experiments/procurement/request-pipeline.js';
import { procurement } from './experiments/procurement/application.js';
import { actor, policy } from './experiments/procurement/comparison-scenario.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const input = { id: 'rq', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }, { sku: 'b', quantity: 1, unitCents: 75 }] };
const raw = { input, actor: actor('buyer') };
const expected = {
  result: { kind: 'request', state: 'draft', id: 'rq', groupId: 'g1', ownerId: 'buyer', version: 1, lines: input.lines, totalCents: 1075 },
  writes: [{ kind: 'request', state: 'draft', id: 'rq', groupId: 'g1', ownerId: 'buyer', version: 1, lines: input.lines, totalCents: 1075 }],
  checks: [{ kind: 'request', groupId: 'g1', id: 'rq', version: null }],
};

test('request creation exposes authorization, parsing and a pure absent-version plan', () => {
  const original = structuredClone(raw), checked = checkRequestCreation(raw), parsed = parseRequestLines(input.lines);
  assert(checked.ok && parsed.ok); assert.strictEqual(checked.value, raw);
  assert(Object.isFrozen(parsed.value)); assert(parsed.value.every(Object.isFrozen));
  const plan = requestCreationPlan(checked.value, parsed.value);
  assert.deepEqual(plan, expected); assert.strictEqual(plan.result.lines, parsed.value);
  assert.deepEqual(requestCreationDecision.inspect(raw), { result: ok(expected), trace: [
    { step: 'authorize-creation', status: 'ok' }, { step: 'parse-lines', status: 'ok' }, { step: 'create-request-plan', status: 'ok' },
  ] });
  assert.deepEqual(createRequest(raw), ok(expected)); assert.deepEqual(raw, original);
});

test('creation prerequisites stop before reading lines and parsing rejects malformed collections', () => {
  let reads = 0;
  const protectedInput = { id: '', get lines() { reads++; throw Error('should not parse'); } };
  assert.deepEqual(requestCreationDecision.run({ actor: actor('finance'), input: protectedInput }), err({ kind: 'Denied' }));
  assert.deepEqual(requestCreationDecision.run({ actor: actor('buyer'), input: protectedInput }), err({ kind: 'InvalidInput' }));
  assert.equal(reads, 0);
  for (const lines of [[], null, [{ sku: 'a', quantity: 0, unitCents: 500 }], [input.lines[0], input.lines[0]],
    [{ sku: 'a', quantity: Number.MAX_SAFE_INTEGER, unitCents: 2 }], Array.from({ length: 1001 }, (_, i) => ({ sku: `s${i}`, quantity: 1, unitCents: 1 }))]) {
    const value = { actor: actor('buyer'), input: { id: 'rq', lines } };
    assert.deepEqual(parseRequestLines(lines), err({ kind: 'InvalidInput' }));
    assert.deepEqual(requestCreationDecision.inspect(value), { result: err({ kind: 'InvalidInput' }), trace: [
      { step: 'authorize-creation', status: 'ok' }, { step: 'parse-lines', status: 'error' },
    ] });
    assert.deepEqual(createRequest(value), err({ kind: 'InvalidInput' }));
  }
});

for (const backend of ['memory', 'sqlite']) test(`creation parsing failure never saves and valid input saves the expected draft: ${backend}`, async () => {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  let saves = 0;
  const commands = procurement({ read: repository.read.bind(repository), related: repository.related.bind(repository),
    commit: (change, identity) => { saves++; return repository.commit(change, identity); },
  }, actor('buyer'), policy);
  type Input = Assert<Equal<Parameters<typeof commands.requests.create>[0], CreateInput>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof commands.requests.create>>, Result<Draft, RuleError | { readonly kind: 'Conflict' | 'NotFound' }>>>;
  try {
    const failed = await commands.requests.create.runDetailed({ id: 'rq', lines: [] });
    assert.deepEqual(failed.result, err({ kind: 'InvalidInput' })); assert.equal(failed.plan, null);
    assert.deepEqual(failed.trace.map(row => row.step), ['procurement.request.v1.create:load', 'authorize-creation', 'parse-lines']);
    assert.equal(saves, 0); assert.deepEqual(repository.list('request', actor('buyer')), []);
    assert.deepEqual(await commands.requests.create(input), ok(expected.result)); assert.equal(saves, 1);
    assert.deepEqual(repository.list('request', actor('buyer')), [expected.result]);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts() {
  const checked = checkRequestCreation(raw), parsed = parseRequestLines(input.lines);
  if (checked.ok && parsed.ok) {
    requestCreationPlan(checked.value, parsed.value);
    // @ts-expect-error ordinary input has no creation authorization proof
    requestCreationPlan(raw, parsed.value);
    // @ts-expect-error an empty array does not prove collection validation
    requestCreationPlan(checked.value, []);
    // @ts-expect-error a public lookalike cannot provide the private creation proof
    requestCreationPlan({ ...raw, requestCreationProof: true }, parsed.value);
  }
}
void typeContracts;
