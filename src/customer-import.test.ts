import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, type Result } from './framework/index.js';
import { customerImport, type Ports } from './examples/customer-import/application.js';
import { createCustomer, updateCustomer, type Customer, type Identification, type Input, type Decision, type InvalidVisitor, type IdentityMismatch } from './examples/customer-import/domain.js';
const input: Input = { groupId: 'g1', visitor: { name: 'New name', email: 'A@example.com' } };
const existing: Customer = { id: 'c1', groupId: 'g1', name: 'Old name', email: 'a@example.com', version: 3 };
function harness(customer: Customer | null) {
  let lookups = 0, writes = 0;
  const decisions: Decision[] = [];
  let row = customer;
  const ports: Ports = {
    identify: async request => { lookups++; return ok(row ? { kind: 'identified', request, customer: row } : { kind: 'not-identified', request, newId: 'c1' }); },
    save: async decision => {
      decisions.push(decision);
      if (decision.kind === 'unchanged') return ok(decision.customer);
      if (decision.kind === 'created' ? row !== null : row?.version !== decision.expectedVersion) return err({ kind: 'Conflict' });
      writes++; row = decision.customer; return ok(row);
    },
  };
  return { ports, decisions, counts: () => ({ lookups, writes }), row: () => row };
}
test('async identification selects create, then unchanged on repeat without another write', async () => {
  const host = harness(null), flow = customerImport(host.ports);
  assert.deepEqual(host.counts(), { lookups: 0, writes: 0 });
  const report = await flow.runDetailed(input);
  assert.deepEqual(report.result, ok({ ...existing, name: 'New name', version: 1 }));
  assert.deepEqual(report.trace, ['validate-visitor', 'identify-customer', 'decide-customer', 'save-customer'].map(step => ({ step, status: 'ok' })));
  assert.equal(report.plan, null);
  await flow.run(input);
  assert.deepEqual(host.decisions.map(d => d.kind), ['created', 'unchanged']);
  assert.deepEqual(host.counts(), { lookups: 2, writes: 1 });
});
test('identified customer follows update with expected version; no create decision', async () => {
  const host = harness(existing);
  assert.deepEqual(await customerImport(host.ports).run(input), ok({ ...existing, name: 'New name', version: 4 }));
  assert.deepEqual(host.decisions[0], { kind: 'updated', customer: { ...existing, name: 'New name', version: 4 }, expectedVersion: 3 });
  assert.deepEqual(existing, { id: 'c1', groupId: 'g1', name: 'Old name', email: 'a@example.com', version: 3 });
});
test('invalid visitor and failed lookup stop before subsequent boundaries', async () => {
  const host = harness(null);
  const invalid = await customerImport(host.ports).runDetailed({ ...input, visitor: null });
  assert.deepEqual(invalid.result, err({ kind: 'InvalidVisitor' }));
  assert.equal(invalid.trace.length, 1); assert.deepEqual(host.counts(), { lookups: 0, writes: 0 });
  const failed = await customerImport({ ...host.ports, identify: async () => err({ kind: 'LookupUnavailable' }) }).runDetailed(input);
  assert.deepEqual(failed.result, err({ kind: 'LookupUnavailable' }));
  assert.deepEqual(failed.trace.at(-1), { step: 'identify-customer', status: 'error' });
  assert.equal(host.decisions.length, 0);
});
test('wrong identity or group from adapter is rejected before saving', async () => {
  for (const row of [{ ...existing, groupId: 'other' }, { ...existing, email: 'other@example.com' }]) {
    const host = harness(row);
    assert.deepEqual(await customerImport(host.ports).run(input), err({ kind: 'IdentityMismatch' }));
    assert.equal(host.decisions.length, 0);
  }
});
test('a concurrent update loses CAS and preserves the committed row', async () => {
  const host = harness(existing);
  const [first, second] = await Promise.all([customerImport(host.ports).run(input), customerImport(host.ports).run(input)]);
  assert.deepEqual(first, ok({ ...existing, name: 'New name', version: 4 }));
  assert.deepEqual(second, err({ kind: 'Conflict' }));
  assert.equal(host.counts().writes, 1);
  assert.equal(host.row()?.version, 4);
});
test('unexpected lookup defect rejects without being disguised as business failure', async () => {
  const host = harness(null), defect = new Error('adapter defect');
  await assert.rejects(customerImport({ ...host.ports, identify: async () => { throw defect; } }).run(input), error => error === defect);
  assert.equal(host.decisions.length, 0);
});
const typed: Promise<Result<Customer, InvalidVisitor | IdentityMismatch | { readonly kind: 'LookupUnavailable' } | { readonly kind: 'Conflict' }>> = customerImport(harness(null).ports).run(input);
void typed;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<Awaited<ReturnType<ReturnType<typeof customerImport>['run']>>, Awaited<typeof typed>> = true;
void exact;
if (false) {
  const identity = null as unknown as Identification;
  // @ts-expect-error unresolved Union is not sufficient to create a new customer
  createCustomer(identity);
  // @ts-expect-error unresolved Union is not sufficient to update an identified customer
  updateCustomer(identity);
}
