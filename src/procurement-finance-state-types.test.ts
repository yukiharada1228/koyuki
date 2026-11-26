import test from 'node:test';
import assert from 'node:assert/strict';
import type { Result } from './framework/index.js';
import { registerCheckedInvoice, matchCheckedInvoice, recordCheckedPayment, cancelCheckedPayment, registerInvoice, matchInvoice, approveInvoice, approveCheckedInvoice, voidInvoice, voidCheckedInvoice,
  recordPayment, cancelPayment, type Invoice, type Payment, type Change } from './experiments/procurement/domain.js';
import { procurement, procurementChanges } from './experiments/procurement/application.js';
import { procurementReplay } from './experiments/procurement/replay.js';
import { MemoryProcurement } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { story, actor, policy } from './experiments/procurement/comparison-scenario.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Value<R> = R extends { ok: true; value: infer T } ? T : never;
type Produced<F extends (...args: never[]) => unknown> = Value<ReturnType<F>>;
type Registered = Extract<Invoice, { state: 'registered' }>;
type Matched = Extract<Invoice, { state: 'matched' }>;
type Approved = Extract<Invoice, { state: 'approved' }>;
type Voided = Extract<Invoice, { state: 'voided' }>;
type Recorded = Extract<Payment, { state: 'recorded' }>;
type Cancelled = Extract<Payment, { state: 'cancelled' }>;
type ProducerContracts = [
  Assert<Equal<ReturnType<typeof registerCheckedInvoice>, Result<Change<Registered>, never>>>,
  Assert<Equal<ReturnType<typeof matchCheckedInvoice>, Result<Change<Matched>, never>>>,
  Assert<Equal<ReturnType<typeof recordCheckedPayment>, Result<Change<Recorded>, never>>>,
  Assert<Equal<ReturnType<typeof cancelCheckedPayment>, Result<Change<Cancelled>, never>>>,
  Assert<Equal<Produced<typeof registerInvoice>, Change<Registered>>>,
  Assert<Equal<Produced<typeof matchInvoice>, Change<Matched>>>,
  Assert<Equal<Produced<typeof approveInvoice>, Change<Approved>>>,
  Assert<Equal<Produced<typeof approveCheckedInvoice>, Change<Approved>>>,
  Assert<Equal<Produced<typeof voidInvoice>, Change<Voided>>>,
  Assert<Equal<Produced<typeof voidCheckedInvoice>, Change<Voided>>>,
  Assert<Equal<Produced<typeof recordPayment>, Change<Recorded>>>,
  Assert<Equal<Produced<typeof cancelPayment>, Change<Cancelled>>>,
];

function publicContracts(repository: MemoryProcurement) {
  const commands = procurement(repository, actor('finance'), policy);
  type Success<F extends (...args: never[]) => unknown> = Value<Awaited<ReturnType<F>>>;
  type Contracts = [
    Assert<Equal<Success<typeof commands.invoices.register>, Registered>>,
    Assert<Equal<Success<typeof commands.invoices.match>, Matched>>,
    Assert<Equal<Success<typeof commands.invoices.approve>, Approved>>,
    Assert<Equal<Success<typeof commands.invoices.void>, Voided>>,
    Assert<Equal<Success<typeof commands.payments.record>, Recorded>>,
    Assert<Equal<Success<typeof commands.payments.cancel>, Cancelled>>,
  ];
  const detailed = procurementChanges(repository, actor('finance'), policy);
  type Detail = Assert<Equal<Success<typeof detailed.invoices.approve>['result'], Approved>>;
}

function replayContracts(repository: SqliteProcurement) {
  const commands = procurementReplay(repository, actor('finance'), policy);
  type Historical<F extends (...args: never[]) => unknown> = Value<Awaited<ReturnType<F>>> extends { value: { result: infer T } } ? T : never;
  type InvoiceHistory = Assert<Equal<Historical<typeof commands.invoices.approve.run>, Invoice>>;
  type PaymentHistory = Assert<Equal<Historical<typeof commands.payments.cancel.run>, Payment>>;
}

for (const backend of ['memory', 'sqlite']) test(`finance next-state contracts agree with saved results: ${backend}`, async () => {
  const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
  try {
    const report = await story(procurement, repository);
    const finance = report.outcomes.filter(row => row.operation.startsWith('invoice.') || row.operation.startsWith('payment.'));
    assert.deepEqual(finance.slice(0, 2).map(row => [row.operation, row.value]), [
      ['invoice.register', { kind: 'invoice', state: 'registered', id: 'voided', groupId: 'g1', orderId: 'po', version: 1, amountCents: 999 }],
      ['invoice.void', { kind: 'invoice', state: 'voided', id: 'voided', groupId: 'g1', orderId: 'po', version: 2, amountCents: 999, reason: 'wrong amount', voidedBy: 'finance' }],
    ]);
    assert.deepEqual(finance.map(row => (row.value as Invoice | Payment).state),
      ['registered', 'voided', 'registered', 'matched', 'approved', 'recorded', 'cancelled']);
    const approved = finance.find(row => row.operation === 'invoice.approve')?.value;
    assert.deepEqual(approved, { kind: 'invoice', state: 'approved', id: 'inv', groupId: 'g1', orderId: 'po', version: 3,
      amountCents: 1000, receiptIds: ['rc'], approvedBy: 'finance' });
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});
