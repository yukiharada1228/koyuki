/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { h, createApplication } from './framework/authoring.js';
import { Registrations, registrationRequest, registrationConfirmation, requestRegistration, confirmRegistration } from './experiments/react-business/registration.js';
import { ReplayRegistrationRepository } from './registration/replay-repository.js';
import { err, type ExecutionEvent } from './framework/index.js';
import { digestToken } from './registration/secrets.js';
const actor = { id: 'session-one', role: 'employee', active: true } as const;
const request = { requestId: 'create-one', id: 'one', email: 'one@example.test' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-registration-authoring-'));
  const path = join(directory, 'registration.sqlite');
  const repository = new ReplayRegistrationRepository(path);
  let closed = false;
  const close = () => { if (!closed) { repository.close(); closed = true; } };
  return { path, repository, close, cleanup() { close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('registration uses the same Hook, Provider, replay and capture API across database restarts', async () => {
  const f = fixture();
  try {
    const events: ExecutionEvent[] = [];
    let app = createApplication(<Registrations repository={f.repository} actor={actor} />, { observeExecution: event => events.push(event) });
    assert.deepEqual(f.repository.read('one'), { ok: true, value: null });
    const first = await app.inspect(registrationRequest, request, {
      input: (_value, step) => step, result: result => result.ok,
    });
    assert.equal(first.result.ok && first.result.value.kind, 'committed');
    assert(first.observations.some(row => row.step === 'request-registration'));
    assert(events.some(event => event.kind === 'completed' && event.status === 'ok'));
    const delivery = await f.repository.claim(0, 100);
    assert(delivery.ok); if (!delivery.ok) throw new Error('ExpectedDelivery');
    const token = delivery.value.event.token;
    await f.repository.acknowledge(delivery.value);
    f.close();
    const reopened = new ReplayRegistrationRepository(f.path);
    try {
      app = createApplication(<Registrations repository={reopened} actor={actor} />);
      const replay = await app.inspect(registrationRequest, request);
      assert.equal(replay.result.ok && replay.result.value.kind, 'replayed'); assert.equal(replay.attempt, null);
      assert.deepEqual(await reopened.claim(200, 100), err({ kind: 'EmptyOutbox' }));
      const confirmation = { requestId: 'confirm-one', id: 'one', token, now: 20 };
      const confirmed = await app.inspect(registrationConfirmation, confirmation);
      assert.equal(confirmed.result.ok && confirmed.result.value.kind, 'committed');
      assert.equal(confirmed.result.ok && confirmed.result.value.value.kind, 'confirmed');
      assert(confirmed.attempt?.trace?.some(row => row.step === 'confirm-registration'));
      const repeated = await app.inspect(registrationConfirmation, confirmation);
      assert.equal(repeated.result.ok && repeated.result.value.kind, 'replayed'); assert.equal(repeated.attempt, null);
      assert.deepEqual(await app.dispatch(registrationRequest, { ...request, email: 'changed@example.test' }), err({ kind: 'IdempotencyConflict' }));
      const other = createApplication(<Registrations repository={reopened} actor={{ ...actor, id: 'other' }} />);
      assert.deepEqual(await other.dispatch(registrationRequest, request), err({ kind: 'IdempotencyConflict' }));
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});
test('receipt insertion failure rolls back both registration and outbox; retry can commit', async () => {
  const f = fixture(), db = new DatabaseSync(f.path);
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON registration_receipts BEGIN SELECT RAISE(ABORT,'fail'); END");
    const app = createApplication(<Registrations repository={f.repository} actor={actor} />);
    assert.deepEqual(await app.dispatch(registrationRequest, request), err({ kind: 'StorageUnavailable' }));
    assert.deepEqual(f.repository.read('one'), { ok: true, value: null });
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_outbox').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM registration_receipts').get()?.n, 0);
    db.exec('DROP TRIGGER fail_receipt');
    const result = await app.dispatch(registrationRequest, request);
    assert.equal(result.ok && result.value.kind, 'committed');
  } finally { db.close(); f.cleanup(); }
});
test('concurrent identical registration requests commit once and create one email event', async () => {
  const f = fixture(), second = new ReplayRegistrationRepository(f.path), db = new DatabaseSync(f.path);
  try {
    const a = createApplication(<Registrations repository={f.repository} actor={actor} />);
    const b = createApplication(<Registrations repository={second} actor={actor} />);
    const results = await Promise.all([a.dispatch(registrationRequest, request), b.dispatch(registrationRequest, request)]);
    assert.deepEqual(results.map(result => result.ok && result.value.kind).sort(), ['committed', 'replayed']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_outbox').get()?.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM registration_receipts').get()?.n, 1);
  } finally { second.close(); db.close(); f.cleanup(); }
});
test('domain calculations remain independently callable and invalid confirmation stops before save', async () => {
  assert.deepEqual(requestRegistration.run({ current: null, input: { id: '', email: '', token: '', tokenDigest: '' } }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(confirmRegistration.run({ current: null, input: { id: 'one', tokenDigest: '', now: 0 } }), err({ kind: 'InvalidConfirmation' }));
  const f = fixture();
  try {
    const app = createApplication(<Registrations repository={f.repository} actor={actor} />);
    await app.dispatch(registrationRequest, request);
    const report = await app.inspect(registrationConfirmation, { requestId: 'bad', id: 'one', token: 'wrong', now: 0 });
    assert.deepEqual(report.result, err({ kind: 'InvalidConfirmation' }));
    assert(!report.attempt?.trace?.some(row => row.step === 'confirm-registration'));
    assert.equal(f.repository.read('one').ok, true);
    if (false) {
      // @ts-expect-error The Hook-derived key retains the registration input.
      void app.dispatch(registrationRequest, { requestId: 'missing', id: 'one' });
      // @ts-expect-error Confirmation does not accept a registration payload.
      void app.dispatch(registrationConfirmation, request);
    }
  } finally { f.cleanup(); }
});
test('a valid confirmation decision cannot be saved under a different token identity', async () => {
  const f = fixture();
  try {
    const app = createApplication(<Registrations repository={f.repository} actor={actor} />);
    await app.dispatch(registrationRequest, request);
    const delivery = await f.repository.claim(0, 100);
    assert(delivery.ok); if (!delivery.ok) throw new Error('ExpectedDelivery');
    const loaded = f.repository.read('one');
    assert(loaded.ok); if (!loaded.ok) throw new Error('ExpectedRegistration');
    const decision = confirmRegistration.run({ current: loaded.value, input: { id: 'one', tokenDigest: await digestToken(delivery.value.event.token), now: 1 } });
    assert(decision.ok); if (!decision.ok) throw new Error('ExpectedDecision');
    assert.deepEqual(await f.repository.saveRequest({ actor, operation: 'confirm', input: { requestId: 'wrong-token', id: 'one', token: 'wrong', now: 1 } }, decision.value), err({ kind: 'InvalidRequest' }));
    assert.deepEqual(f.repository.read('one'), loaded);
  } finally { f.cleanup(); }
});
