/** @jsx h3 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, type Result } from './core.js';
import { Backend, prepareReservation, prepareOrder, type ReservationCandidate, type ReservationSaved, type Conflict, type MailRejected } from './comparison/domain.js';
import { Execution, Journal, Program, operation, fingerprint, h3 } from './comparison/kernel.js';
import { createProcesses, defineCommitAndNotify } from './comparison/components.js';
import { reservationInline, orderInline, reservationShared, orderShared, commitAndNotify } from './comparison/plain.js';

const reservation: ReservationCandidate = { kind: 'reservation-candidate', id: 'a', seats: 1 };
const order = { kind: 'order-candidate' as const, id: 'a', amount: 1200 };
type Mode = 'jsx' | 'inline' | 'shared-ts';
type Domain = 'reservation' | 'order';
function fixture(mode: Mode, domain: Domain) {
  const backend = new Backend(), journal = new Journal(), execution = new Execution(journal);
  const components = createProcesses(backend);
  const run = (executor = execution): Promise<Result<unknown, unknown>> => {
    if (mode === 'jsx') {
      const program = domain === 'reservation' ? components.ReservationProcess({ input: reservation }) : components.OrderProcess({ input: order });
      return program.run({ execution: executor, scope: `${domain}:a` });
    }
    if (mode === 'inline') return domain === 'reservation' ? reservationInline(executor, `${domain}:a`, backend, reservation) : orderInline(executor, `${domain}:a`, backend, order);
    return domain === 'reservation' ? reservationShared(executor, `${domain}:a`, backend, reservation) : orderShared(executor, `${domain}:a`, backend, order);
  };
  return { backend, journal, execution, run };
}
for (const mode of ['jsx', 'inline', 'shared-ts'] as const) for (const domain of ['reservation', 'order'] as const) {
  const prefix = `${mode}/${domain}`;
  test(`${prefix}: success returns saved value and notifies only after commit`, async () => {
    const f = fixture(mode, domain), result = await f.run();
    assert(result.ok); assert.equal((result.value as { kind: string }).kind, `${domain}-saved`);
    assert.deepEqual(f.backend.events, [`save-${domain}`, 'notify-attempt']);
    assert.deepEqual(f.backend.mail, [`${domain}:a`]);
  });
  test(`${prefix}: conflict stops before notification`, async () => {
    const f = fixture(mode, domain); f.backend.conflict = true;
    assert.deepEqual(await f.run(), { ok: false, error: { kind: 'conflict' } });
    assert.equal(f.backend.mail.length, 0); assert.deepEqual(f.backend.events, [`save-${domain}`]);
  });
  test(`${prefix}: notification business error preserves saved record`, async () => {
    const f = fixture(mode, domain); f.backend.mailFailure = 'business';
    assert.deepEqual(await f.run(), { ok: false, error: { kind: 'mail-rejected' } });
    assert.equal(f.backend.reservations.size + f.backend.orders.size, 1);
  });
  test(`${prefix}: infrastructure exception retries notification without rerunning save`, async () => {
    const f = fixture(mode, domain); f.backend.mailFailure = 'infrastructure';
    await assert.rejects(f.run(), /ProviderUnavailable/);
    f.backend.mailFailure = 'none'; assert((await f.run()).ok);
    assert.equal(f.backend.events.filter(event => event.startsWith('save')).length, 1);
    assert.equal(f.backend.mail.length, 1);
  });
  test(`${prefix}: two executions sharing journal replay results instead of duplicating effects`, async () => {
    const f = fixture(mode, domain);
    await Promise.all([f.run(), f.run(new Execution(f.journal))]);
    const result = await f.run(new Execution(f.journal)); assert(result.ok);
    assert.deepEqual(f.backend.events, [`save-${domain}`, 'notify-attempt']);
  });
  test(`${prefix}: crash after provider success retries with same idempotency key`, async () => {
    const f = fixture(mode, domain);
    f.execution.afterExternal = name => { if (name.includes('notify')) throw new Error('CrashAfterSend'); };
    await assert.rejects(f.run(), /CrashAfterSend/);
    assert((await f.run(new Execution(f.journal))).ok); assert.equal(f.backend.mail.length, 1);
  });
  test(`${prefix}: non-idempotent provider retains duplicate-delivery limitation`, async () => {
    const f = fixture(mode, domain); f.backend.providerIdempotent = false;
    f.execution.afterExternal = name => { if (name.includes('notify')) throw new Error('CrashAfterSend'); };
    await assert.rejects(f.run()); await f.run(new Execution(f.journal));
    assert.equal(f.backend.mail.length, 2);
  });
}

test('JSX declaration alone does not save or notify; separate domains can share one component implementation', async () => {
  const backend = new Backend(), execution = new Execution(), { ReservationCommit, OrderCommit } = createProcesses(backend);
  const a = <ReservationCommit input={reservation} />;
  const b = <OrderCommit input={order} />;
  assert.equal(backend.events.length, 0);
  await a.run({ execution, scope: 'reservation:a' }); await b.run({ execution, scope: 'order:a' });
  assert.equal(backend.reservations.size, 1); assert.equal(backend.orders.size, 1);
});
test('declaration captures input; later caller mutation cannot change committed value', async () => {
  const backend = new Backend(), execution = new Execution(), { ReservationCommit } = createProcesses(backend);
  const input = { ...reservation }; const declaration = <ReservationCommit input={input} />;
  input.seats = 9; await declaration.run({ execution, scope: 'reservation:a' });
  assert.equal(backend.reservations.get('a')?.seats, 1);
});
test('same scope/slot with changed input is rejected rather than skipped', async () => {
  const backend = new Backend(), execution = new Execution(), { ReservationCommit } = createProcesses(backend);
  await ReservationCommit({ input: reservation }).run({ execution, scope: 'a' });
  await assert.rejects(ReservationCommit({ input: { ...reservation, seats: 2 } }).run({ execution, scope: 'a' }), /IdentityMismatch/);
});
test('no global IO lock: slow notification does not block another operation', async () => {
  const execution = new Execution(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const slow = operation<Record<string, never>, void, never>({ name: 'slow.v1', run: async () => { entered(); await gate; return ok(undefined); } });
  const fast = operation<string, string, never>({ name: 'fast.v1', run: async input => ok(input) });
  const running = execution.call('a', 'notify', slow, {});
  try { await started; assert.deepEqual(await execution.call('b', 'save', fast, 'saved'), ok('saved')); }
  finally { release(); await running; }
});
test('pure domain preparation rejects invalid values before either implementation runs', () => {
  assert.deepEqual(prepareReservation('a', 0), { ok: false, error: 'InvalidPartySize' });
  assert.deepEqual(prepareOrder('a', NaN), { ok: false, error: 'InvalidAmount' });
});
test('canonical operation identity ignores object key order and rejects lossy input', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  for (const input of [undefined, NaN, Infinity, { a: undefined }, new Date()]) assert.throws(() => fingerprint(input));
});

function typeAssertions() {
  const backend = new Backend(), { ReservationCommit, OrderCommit } = createProcesses(backend);
  // @ts-expect-error Saving an order is not a reservation operation.
  const wrongInput = <ReservationCommit input={order} />;
  // @ts-expect-error Notification consumes the saved state of the SAME domain.
  defineCommitAndNotify({ name: 'bad', commit: backend.saveReservation, notify: backend.notifyOrder });
  // @ts-expect-error Notification needs a receipt, not a candidate.
  backend.notifyReservation.run(reservation, { idempotencyKey: 'a' });
  const typed: Program<ReservationSaved, Conflict | MailRejected> = ReservationCommit({ input: reservation });
  // @ts-expect-error Business error union cannot erase Conflict.
  const erasedError: Program<ReservationSaved, MailRejected> = typed;
  // @ts-expect-error JSX result is widened; direct function form retains result/error types.
  const jsxTyped: Program<ReservationSaved, Conflict | MailRejected> = <ReservationCommit input={reservation} />;
  // @ts-expect-error Different domain cannot be passed through another domain's component.
  const wrongOrder = <OrderCommit input={reservation} />;
  return [wrongInput, erasedError, jsxTyped, wrongOrder];
}
void typeAssertions;

// Change experiment: add an audit step after save and before notification.
for (const mode of ['jsx', 'inline', 'shared-ts'] as const) for (const domain of ['reservation', 'order'] as const) {
  for (const fail of [false, true]) test(`${mode}/${domain}: shared audit extension ${fail ? 'fails before mail' : 'runs in order'}`, async () => {
    const backend = new Backend(), execution = new Execution(); backend.auditFailure = fail;
    let result: Result<unknown, unknown>;
    if (mode === 'jsx') {
      const ReservationWithAudit = defineCommitAndNotify({ name: 'reservation', commit: backend.saveReservation, notify: backend.notifyReservation, beforeNotify: backend.audit });
      const OrderWithAudit = defineCommitAndNotify({ name: 'order', commit: backend.saveOrder, notify: backend.notifyOrder, beforeNotify: backend.audit });
      const node = domain === 'reservation' ? <ReservationWithAudit input={reservation} /> : <OrderWithAudit input={order} />;
      result = await node.run({ execution, scope: `${domain}:audit:a` });
    } else if (mode === 'inline') {
      result = await (domain === 'reservation'
        ? reservationInline(execution, 'reservation:audit:a', backend, reservation, backend.audit)
        : orderInline(execution, 'order:audit:a', backend, order, backend.audit));
    } else {
      result = await (domain === 'reservation'
        ? commitAndNotify(execution, 'reservation:audit:a', 'reservation', backend.saveReservation, backend.notifyReservation, reservation, backend.audit)
        : commitAndNotify(execution, 'order:audit:a', 'order', backend.saveOrder, backend.notifyOrder, order, backend.audit));
    }
    assert.deepEqual(backend.events, [`save-${domain}`, `audit:${domain}-saved`, ...(fail ? [] : ['notify-attempt'])]);
    assert.equal(backend.reservations.size + backend.orders.size, 1);
    if (fail) assert.deepEqual(result, { ok: false, error: { kind: 'audit-rejected' } });
    else assert(result.ok);
  });
}

test('composition limit: two instances of same component need distinct scopes/slots', async () => {
  const backend = new Backend(), execution = new Execution(), { ReservationCommit } = createProcesses(backend);
  const second = { ...reservation, id: 'b' };
  await ReservationCommit({ input: reservation }).run({ execution, scope: 'parent' });
  await assert.rejects(ReservationCommit({ input: second }).run({ execution, scope: 'parent' }), /IdentityMismatch/);
  await ReservationCommit({ input: second }).run({ execution, scope: 'parent/child-b' });
  assert.equal(backend.reservations.size, 2); assert.equal(backend.mail.length, 2);
});
