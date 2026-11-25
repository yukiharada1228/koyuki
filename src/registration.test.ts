import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { registration, digest } from './registration/application.js';
import { validateConfirm, confirm } from './registration/domain.js';
import { RegistrationRepository } from './registration/repository.js';
import { emailWorker } from './registration/delivery.js';
import { err } from './framework/index.js';
import type { EmailRequested } from './registration/domain.js';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-registration-')), path = join(dir, 'db.sqlite');
  let repository = new RegistrationRepository(path);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, get repository() { return repository; }, restart() { repository.close(); repository = new RegistrationRepository(path); } };
}
const person = { id: 'person', email: 'person@example.com' };
test('registration, email delivery and human confirmation survive independent restarts', async t => {
  const f = fixture(t), messages: EmailRequested[] = [];
  const first = await registration(f.repository).request(person); assert(first.ok); assert.equal(first.value.kind, 'awaiting');
  f.restart();
  const delivered = await emailWorker(f.repository, { send: async e => { messages.push(e); } }).runDetailed({ now: 100, leaseMs: 10 });
  assert(delivered.result.ok);
  assert.deepEqual(delivered.trace, ['claim-email', 'send-email', 'ack-email'].map(step => ({ step, status: 'ok' })));
  assert.equal(delivered.plan, null);
  assert.equal(messages.length, 1);
  const waiting = f.repository.read(person.id); assert(waiting.ok); assert.equal(waiting.value?.kind, 'awaiting');
  f.restart();
  assert.deepEqual(await registration(f.repository).confirm({ id: person.id, token: 'wrong', now: 200 }), err({ kind: 'InvalidConfirmation' }));
  const confirmed = await registration(f.repository).confirm({ id: person.id, token: messages[0]!.token, now: 200 });
  assert(confirmed.ok); assert.equal(confirmed.value.kind, 'confirmed'); assert.equal(confirmed.value.version, 2);
  assert(!('tokenDigest' in confirmed.value));
  f.restart(); const final = f.repository.read(person.id); assert(final.ok); assert.deepEqual(final.value, confirmed.value);
  assert.deepEqual(await emailWorker(f.repository, { send: async () => { assert.fail('already acknowledged'); } }).run({ now: 300, leaseMs: 10 }), err({ kind: 'EmptyOutbox' }));
});

test('registration and outbox insertion roll back together when the second write fails', async t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_email BEFORE INSERT ON email_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
  assert.deepEqual(await registration(f.repository).request(person), err({ kind: 'StorageUnavailable' }));
  assert.deepEqual(f.repository.read(person.id), { ok: true, value: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_outbox').get()?.count, 0);
  db.exec('DROP TRIGGER fail_email'); db.close();
  assert((await registration(f.repository).request(person)).ok);
});

test('failed delivery resumes after lease expiry, with no premature acknowledgement', async t => {
  const f = fixture(t); assert((await registration(f.repository).request(person)).ok);
  let calls = 0;
  const worker = emailWorker(f.repository, { send: async () => { calls++; if (calls === 1) throw new Error('offline'); } });
  const failed = await worker.runDetailed({ now: 100, leaseMs: 10 });
  assert.deepEqual(failed.result, err({ kind: 'DeliveryUnavailable' }));
  assert.equal(failed.trace.at(-1)?.step, 'send-email');
  assert.deepEqual(await worker.run({ now: 109, leaseMs: 10 }), err({ kind: 'EmptyOutbox' }));
  assert.equal(calls, 1); f.restart();
  assert((await emailWorker(f.repository, { send: async () => { calls++; } }).run({ now: 110, leaseMs: 10 })).ok);
  assert.equal(calls, 2);
});

test('lost acknowledgement retries with the same event id; transport deduplication is explicit', async t => {
  const f = fixture(t); assert((await registration(f.repository).request(person)).ok);
  let attempts = 0; const accepted = new Set<string>();
  const sender = { send: async (e: EmailRequested) => { attempts++; accepted.add(e.id); } };
  f.repository.acknowledge = async () => err({ kind: 'StorageUnavailable' });
  assert.deepEqual(await emailWorker(f.repository, sender).run({ now: 100, leaseMs: 10 }), err({ kind: 'StorageUnavailable' }));
  f.restart();
  assert((await emailWorker(f.repository, sender).run({ now: 110, leaseMs: 10 })).ok);
  assert.equal(attempts, 2); assert.equal(accepted.size, 1);
});

test('independent workers cannot claim a live lease and stale owners cannot acknowledge a new lease', async t => {
  const f = fixture(t); assert((await registration(f.repository).request(person)).ok);
  const other = new RegistrationRepository(f.path); t.after(() => other.close());
  const [a, b] = await Promise.all([f.repository.claim(100, 10), other.claim(100, 10)]);
  assert(a.ok); assert.deepEqual(b, err({ kind: 'EmptyOutbox' }));
  const renewed = await other.claim(110, 10); assert(renewed.ok);
  assert.notEqual(a.value.claim, renewed.value.claim);
  assert.deepEqual(await f.repository.acknowledge(a.value), err({ kind: 'Conflict' }));
  assert((await other.acknowledge(renewed.value)).ok);
});

test('concurrent confirmation preserves one accepted state transition', async t => {
  const f = fixture(t), messages: EmailRequested[] = [];
  assert((await registration(f.repository).request(person)).ok);
  assert((await emailWorker(f.repository, { send: async e => { messages.push(e); } }).run({ now: 100, leaseMs: 10 })).ok);
  const other = new RegistrationRepository(f.path); t.after(() => other.close());
  const input = { id: person.id, tokenDigest: await digest(messages[0]!.token), now: 200 };
  const before = f.repository.read(person.id); assert(before.ok);
  const validated = validateConfirm({ current: before.value, input }); assert(validated.ok);
  const change = confirm(validated.value); assert(change.ok);
  // Both writers deliberately use the same snapshot, independent of crypto scheduling.
  const results = await Promise.all([f.repository.save(change.value), other.save(change.value)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(results.find(r => !r.ok), err({ kind: 'Conflict' }));
  const stored = other.read(person.id); assert(stored.ok); assert.equal(stored.value?.version, 2);
});

test('invalid registration, corrupt persisted events and invalid lease windows stop delivery', async t => {
  const f = fixture(t);
  assert.deepEqual(await registration(f.repository).request({ id: 'bad', email: 'bad' }), err({ kind: 'InvalidInput' }));
  assert.deepEqual(await f.repository.claim(0, 1), err({ kind: 'EmptyOutbox' }));
  assert((await registration(f.repository).request(person)).ok);
  assert.deepEqual(await f.repository.claim(Number.MAX_SAFE_INTEGER, 1), err({ kind: 'InvalidLease' }));
  const db = new DatabaseSync(f.path); db.exec("UPDATE email_outbox SET payload='{}'"); db.close();
  assert.deepEqual(await emailWorker(f.repository, { send: async () => assert.fail('corrupt event') }).run({ now: 100, leaseMs: 10 }), err({ kind: 'CorruptRegistration' }));
});


test('separate OS processes resume persisted request, delivery and confirmation', t => {
  const f = fixture(t);
  const application = new URL('./registration/application.js', import.meta.url).href;
  const repository = new URL('./registration/repository.js', import.meta.url).href;
  const delivery = new URL('./registration/delivery.js', import.meta.url).href;
  function child(code: string) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { registration } from ${JSON.stringify(application)};
      import { RegistrationRepository } from ${JSON.stringify(repository)};
      import { emailWorker } from ${JSON.stringify(delivery)};
      const repository = new RegistrationRepository(${JSON.stringify(f.path)});
      try { ${code} } finally { repository.close(); }
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const requested = child(`console.log(JSON.stringify(await registration(repository).request(${JSON.stringify(person)})));`);
  assert.equal(requested.ok, true);
  const message = child(`let event; const result = await emailWorker(repository, { send: async value => { event = value; } }).run({ now: 100, leaseMs: 10 });
    if (!result.ok) throw new Error(result.error.kind); console.log(JSON.stringify(event));`);
  const confirmed = child(`console.log(JSON.stringify(await registration(repository).confirm(${JSON.stringify({ id: person.id, token: message.token, now: 200 })})));`);
  assert.equal(confirmed.ok, true); assert.equal(confirmed.value.kind, 'confirmed');
  const stored = f.repository.read(person.id); assert(stored.ok); assert.deepEqual(stored.value, confirmed.value);
});

function stateTypeChecks() {
  // @ts-expect-error awaiting states must contain the confirmation digest
  const awaiting: import('./registration/domain.js').Registration = { id: 'a', email: 'a@example.com', kind: 'awaiting', version: 1 };
  // @ts-expect-error confirmed states require a confirmation time and version 2
  const confirmed: import('./registration/domain.js').Registration = { id: 'a', email: 'a@example.com', kind: 'confirmed', version: 1, tokenDigest: 'old' };
  // @ts-expect-error domain evolution accepts only the privately validated proof
  confirm({ current: { id: 'a', email: 'a@example.com', kind: 'awaiting', version: 1, tokenDigest: 'old' }, input: { id: 'a', tokenDigest: 'old', now: 1 } });
  void awaiting; void confirmed;
}
void stateTypeChecks;
