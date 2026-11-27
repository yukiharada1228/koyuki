/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, err, type Result, type Execution } from './framework/index.js';
import { h, Fragment, createApplication, createApplicationTemplate, createContext, useContext, Guard, ExecutionDenied } from './framework/authoring.js';
import { ActorContext } from './experiments/declarative-booking/business.js';
import { bookingId, actorId, rescheduling, reschedule, authorizeRescheduling, type Confirmed } from './experiments/declarative-booking/domain.js';
import { ReschedulingBusiness, ReschedulingNotifications, rescheduleBooking, type ReschedulingRepository, type ReschedulingNotice } from './experiments/declarative-booking/rescheduling.js';
import { parseRescheduleRequest } from './experiments/declarative-booking/rescheduling-request.js';
import { memoryBookings } from './experiments/declarative-booking/memory.js';
import { SqliteBookings } from './experiments/declarative-booking/sqlite.js';
function valid<T, E>(result: Result<T, E>): T { if (!result.ok) throw new Error('InvalidFixture'); return result.value; }
const hour = 3_600_000, now = 2_000_000_000_000;
const initial: Confirmed = Object.freeze({ kind: 'confirmed', id: valid(bookingId('one')), owner: valid(actorId('alice')), approvedBy: valid(actorId('boss')), startsAt: now + 36 * hour });
const input = { requestId: 'change-1', id: initial.id, startsAt: now + 72 * hour };
function context() { return { booking: { ...initial }, actor: { id: initial.owner, role: 'member' as const }, request: { ...input }, time: { now, noticeHours: 24 } }; }
function mount(repository: ReschedulingRepository, send: (notice: ReschedulingNotice) => Promise<Result<null, 'DeliveryUnavailable'>>, actor = initial.owner, clock = () => now, noticeHours = 24) {
  return createApplication(<ActorContext.Provider value={{ id: actor, role: 'member' }}><Fragment>
    <ReschedulingBusiness repository={repository} clock={clock} noticeHours={noticeHours} />
    <ReschedulingNotifications sender={{ send }} />
  </Fragment></ActorContext.Provider>);
}
test('rescheduling is a pure proved transition with owner, time, identity and exact deadline checks', () => {
  const original = context(), result = rescheduling.run(original); assert(result.ok);
  assert.equal(original.booking.startsAt, initial.startsAt); assert.equal(result.value.next.startsAt, input.startsAt);
  assert.equal(result.value.next.approvedBy, initial.approvedBy);
  for (const offset of [-1, 0, 1]) {
    const c = context(); c.time = { now: initial.startsAt - 24 * hour + offset, noticeHours: 24 };
    const outcome = rescheduling.run(c);
    assert(offset <= 0 ? outcome.ok : !outcome.ok && outcome.error === 'ReschedulingClosed');
  }
  assert.deepEqual(rescheduling.run({ ...context(), actor: { id: valid(actorId('intruder')), role: 'manager' } }), err('Forbidden'));
  assert.deepEqual(rescheduling.run({ ...context(), booking: { ...initial, kind: 'requested' } }), err('InvalidState'));
  assert.deepEqual(rescheduling.run({ ...context(), request: { ...input, id: valid(bookingId('other')) } }), err('BookingMismatch'));
  assert.deepEqual(rescheduling.run({ ...context(), request: { ...input, startsAt: initial.startsAt } }), err('Unchanged'));
  for (const startsAt of [now, now - 1, NaN, Infinity, 1.5]) assert.deepEqual(rescheduling.run({ ...context(), request: { ...input, startsAt } }), err('InvalidTime'));
  for (const noticeHours of [0, -1, NaN, Infinity]) assert.deepEqual(rescheduling.run({ ...context(), time: { now, noticeHours } }), err('InvalidTime'));
  const checked = authorizeRescheduling(original); assert(checked.ok);
  original.booking.startsAt = now;
  original.request.startsAt = now;
  const changed = reschedule(checked.value); assert(changed.ok); assert.equal(changed.value.previous.startsAt, initial.startsAt); assert.equal(changed.value.next.startsAt, input.startsAt);
  if (false) {
    // @ts-expect-error The transition requires successful authorization.
    void reschedule({ previous: initial, startsAt: input.startsAt });
  }
});
test('JSX registration performs no IO; invalid input and forbidden or closed changes never save or notify', async () => {
  let reads = 0, saves = 0, sends = 0, clocks = 0;
  const memory = memoryBookings([initial]);
  const repository: ReschedulingRepository = { ...memory, async load(input) { reads++; return memory.load(input); }, async reschedule(...args) { saves++; return memory.reschedule(...args); } };
  const sender = async () => { sends++; return ok(null); };
  const app = mount(repository, sender, initial.owner, () => { clocks++; return now; });
  assert.deepEqual([reads, saves, sends, clocks], [0, 0, 0, 0]);
  for (const body of [null, {}, { id: 1, startsAt: input.startsAt }, { id: 'one' }, { id: 'one', startsAt: NaN }, { id: 'one', startsAt: input.startsAt }, { requestId: 42, id: 'one', startsAt: input.startsAt }]) {
    const handle = async () => { const parsed = parseRescheduleRequest(body); return parsed.ok ? app.execute(rescheduleBooking, parsed.value) : parsed; };
    assert(!(await handle()).ok);
  }
  assert.deepEqual([reads, saves, sends, clocks], [0, 0, 0, 0]);
  const forbidden = await mount(repository, sender, valid(actorId('intruder'))).execute(rescheduleBooking, input);
  assert.deepEqual(forbidden, err('Forbidden')); assert.equal(saves, 0); assert.equal(sends, 0);
  const closed = await mount(repository, sender, initial.owner, () => initial.startsAt - hour).execute(rescheduleBooking, input);
  assert.deepEqual(closed, err('ReschedulingClosed')); assert.equal(saves, 0); assert.equal(sends, 0);
  const report = await app.executeDetailed(rescheduleBooking, valid(parseRescheduleRequest({ requestId: input.requestId, id: 'one', startsAt: input.startsAt })));
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  const exact: Equal<Extract<typeof report.result, { ok: true }>['value'], Execution<Confirmed>> = true; assert(exact);
  assert(report.result.ok); assert.equal(saves, 1); assert.equal(sends, 1);
  assert(report.attempt?.trace?.some(row => row.step === 'authorize-rescheduling')); assert(report.attempt?.trace?.some(row => row.step === 'reschedule'));
  const repeated = await app.executeDetailed(rescheduleBooking, input); assert(repeated.result.ok && repeated.result.value.kind === 'replayed'); assert.equal(repeated.attempt, null); assert.equal(saves, 1); assert.equal(sends, 1);
  const unchanged = await app.execute(rescheduleBooking, { ...input, requestId: 'new-request' }); assert.deepEqual(unchanged, err('Unchanged')); assert.equal(saves, 1); assert.equal(sends, 1);
});
test('two stale reschedules cannot overwrite each other or publish twice in memory or SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-rescheduling-race-')), sqlite = new SqliteBookings(join(dir, 'db.sqlite')); sqlite.seed(initial);
  try {
    for (const underlying of [memoryBookings([initial]), sqlite]) {
      let loaded = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const repository: ReschedulingRepository = { load: async input => {
        const value = await underlying.load(input); loaded++; if (loaded === 2) release(); await gate; return value;
      }, reschedulingReceipt: underlying.reschedulingReceipt.bind(underlying), reschedule: underlying.reschedule.bind(underlying) };
      const notices: ReschedulingNotice[] = [], app = mount(repository, async notice => { notices.push(notice); return ok(null); });
      const results = await Promise.all([app.executeDetailed(rescheduleBooking, input), app.executeDetailed(rescheduleBooking, { ...input, requestId: 'competing-change', startsAt: now + 96 * hour })]);
      assert.equal(results.filter(r => r.result.ok).length, 1);
      assert.equal(results.filter(r => !r.result.ok && r.result.error === 'ConcurrentChange').length, 1);
      assert.equal(results.flatMap(r => r.publications).length, 1); assert.equal(notices.length, 1); assert.equal(underlying.pending().length, 1);
    }
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('SQLite rescheduling rolls back outbox failures and redelivers notifications after reopening without changing state again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-rescheduling-')), path = join(dir, 'db.sqlite'); let repository = new SqliteBookings(path); repository.seed(initial);
  try {
    let sends = 0;
    const app = mount(repository, async () => { sends++; return err('DeliveryUnavailable'); });
    repository.db.exec("CREATE TRIGGER reject_rescheduling BEFORE INSERT ON booking_outbox BEGIN SELECT RAISE(ABORT,'outbox failed'); END");
    const failed = await app.executeDetailed(rescheduleBooking, input);
    assert.deepEqual(failed.result, err('StorageFailed')); assert.equal(failed.deliveries.length, 0); assert.equal(sends, 0); assert.equal(repository.pending().length, 0);
    assert.deepEqual(await repository.load(input), ok(initial));
    repository.db.exec('DROP TRIGGER reject_rescheduling');
    const saved = await app.executeDetailed(rescheduleBooking, input); assert(saved.result.ok); assert.equal(saved.deliveries[0]?.status, 'error'); assert.equal(sends, 1);
    const event = repository.pending()[0]!;
    repository.close(); repository = new SqliteBookings(path);
    const notices: ReschedulingNotice[] = [];
    const worker = createApplication(<ReschedulingNotifications sender={{ async send(notice) { notices.push(notice); return ok(null); } }} />);
    const invalid = await worker.deliver({ ...event, payload: { previous: initial, next: { ...initial, owner: 'intruder', startsAt: input.startsAt } } });
    assert.equal(invalid.deliveries[0]?.status, 'error'); assert.equal(notices.length, 0);
    const delivered = await worker.deliver(event); assert(delivered.deliveries.every(row => row.status === 'ok')); repository.acknowledge(event.id);
    assert.deepEqual(notices, [{ bookingId: initial.id, owner: initial.owner, previousStartsAt: initial.startsAt, startsAt: input.startsAt }]);
    assert.equal(repository.pending().length, 0); assert.deepEqual(await repository.load(input), ok({ ...initial, startsAt: input.startsAt }));
  } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the same component supports 24h and 48h policies with isolated actor, repository and clock scopes', async () => {
  const alice = memoryBookings([initial]), bobState = { ...initial, owner: valid(actorId('bob')) }, bob = memoryBookings([bobState]);
  const sent: ReschedulingNotice[] = [];
  const sender = async (notice: ReschedulingNotice) => { sent.push(notice); return ok(null); };
  let clock = now;
  const a = mount(alice, sender, initial.owner, () => clock, 24), b = mount(bob, sender, bobState.owner, () => clock, 48);
  const [allowed, denied] = await Promise.all([a.execute(rescheduleBooking, input), b.execute(rescheduleBooking, input)]);
  assert(allowed.ok); assert.deepEqual(denied, err('ReschedulingClosed')); assert.equal(sent.length, 1); assert.equal(sent[0]?.owner, initial.owner);
  assert.deepEqual(await bob.load(input), ok(bobState));
  clock = initial.startsAt - 48 * hour;
  assert((await b.execute(rescheduleBooking, input)).ok); assert.equal(sent.length, 2); assert.equal(sent[1]?.owner, bobState.owner);
});

async function withReschedulingStores(check: (repository: ReschedulingRepository & { pending(): readonly import('./framework/authoring.js').EventEnvelope[] }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-rescheduling-receipts-')), sqlite = new SqliteBookings(join(dir, 'db.sqlite'));
  sqlite.seed(initial);
  try { for (const repository of [memoryBookings([initial]), sqlite]) await check(repository); }
  finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
}
function observedRepository(repository: ReschedulingRepository) {
  const counts = { loads: 0, saves: 0, lookups: 0 };
  const observed: ReschedulingRepository = {
    async load(input) { counts.loads++; return repository.load(input); },
    async reschedulingReceipt(input, identity) { counts.lookups++; return repository.reschedulingReceipt(input, identity); },
    async reschedule(...args) { counts.saves++; return repository.reschedule(...args); },
  };
  return { repository: observed, counts };
}
test('a receipt preserves the original result after later changes and rejects reused request IDs with other inputs or actors before loading', async () => {
  await withReschedulingStores(async repository => {
    let sends = 0;
    const observed = observedRepository(repository), app = mount(observed.repository, async () => { sends++; return ok(null); });
    const first = await app.execute(rescheduleBooking, input); assert(first.ok && first.value.kind === 'committed');
    const latest = { ...input, requestId: 'later-change', startsAt: now + 96 * hour };
    assert((await app.execute(rescheduleBooking, latest)).ok);
    const before = { ...observed.counts };
    const replay = await app.executeDetailed(rescheduleBooking, input);
    assert(replay.result.ok); assert.deepEqual(replay.result.value, { kind: 'replayed', value: first.value.value }); assert.equal(replay.attempt, null);
    assert.equal(replay.publications.length, 0); assert.equal(replay.deliveries.length, 0);
    assert.equal(observed.counts.loads, before.loads); assert.equal(observed.counts.saves, before.saves);
    const state = await repository.load(input); assert(state.ok && state.value.startsAt === latest.startsAt);
    const conflicting = [input, { ...input, startsAt: latest.startsAt }, { ...input, id: valid(bookingId('other')) }];
    assert.deepEqual(await mount(observed.repository, async () => ok(null), valid(actorId('intruder'))).execute(rescheduleBooking, conflicting[0]!), err('IdempotencyConflict'));
    for (const changed of conflicting.slice(1)) assert.deepEqual(await app.execute(rescheduleBooking, changed), err('IdempotencyConflict'));
    assert.equal(observed.counts.loads, before.loads); assert.equal(observed.counts.saves, before.saves);
    assert.equal(sends, 2); assert.equal(repository.pending().length, 2);
    const lookupCount = observed.counts.lookups;
    assert.deepEqual(await app.execute(rescheduleBooking, { ...input, requestId: ' ' }), err('InvalidRequestId'));
    assert.equal(observed.counts.lookups, lookupCount);
  });
});
test('concurrent identical requests commit once; differing payloads under the same request ID conflict without republishing', async () => {
  for (const differing of [false, true]) await withReschedulingStores(async underlying => {
    let loads = 0, release!: () => void, sends = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const repository: ReschedulingRepository = {
      reschedulingReceipt: underlying.reschedulingReceipt.bind(underlying), reschedule: underlying.reschedule.bind(underlying),
      async load(input) { const value = await underlying.load(input); if (++loads === 2) release(); await gate; return value; },
    };
    const app = mount(repository, async () => { sends++; return ok(null); });
    const other = differing ? { ...input, startsAt: now + 96 * hour } : input;
    const results = await Promise.all([app.executeDetailed(rescheduleBooking, input), app.executeDetailed(rescheduleBooking, other)]);
    assert.equal(results.filter(r => r.result.ok && r.result.value.kind === 'committed').length, 1);
    if (differing) assert.equal(results.filter(r => !r.result.ok && r.result.error === 'IdempotencyConflict').length, 1);
    else {
      assert.equal(results.filter(r => r.result.ok && r.result.value.kind === 'replayed').length, 1);
      assert(results.every(r => r.attempt !== null)); // This race reaches the atomic save check.
    }
    assert.equal(results.flatMap(r => r.publications).length, 1); assert.equal(sends, 1); assert.equal(underlying.pending().length, 1);
  });
});
test('unknown commit resolves from the receipt without recomputing or publishing; the durable outbox remains deliverable', async () => {
  await withReschedulingStores(async underlying => {
    let writes = 0, sends = 0;
    const repository: ReschedulingRepository = {
      load: underlying.load.bind(underlying), reschedulingReceipt: underlying.reschedulingReceipt.bind(underlying),
      async reschedule(...args) { writes++; const result = await underlying.reschedule(...args); return result.ok && result.value.kind === 'committed' ? err('StorageFailed') : result; },
    };
    const app = mount(repository, async () => { sends++; return ok(null); });
    const report = await app.executeDetailed(rescheduleBooking, input);
    assert(report.result.ok && report.result.value.kind === 'replayed'); assert.deepEqual(report.attempt?.result, err('StorageFailed'));
    assert.equal(writes, 1); assert.equal(sends, 0); assert.equal(report.publications.length, 0); assert.equal(underlying.pending().length, 1);
    const retry = await app.executeDetailed(rescheduleBooking, input); assert(retry.result.ok && retry.result.value.kind === 'replayed'); assert.equal(retry.attempt, null); assert.equal(writes, 1);
    const worker = createApplication(<ReschedulingNotifications sender={{ async send() { sends++; return ok(null); } }} />);
    const delivered = await worker.deliver(underlying.pending()[0]!); assert(delivered.deliveries.every(row => row.status === 'ok')); assert.equal(sends, 1);
  });
});
test('a lost response can be retried after DB reconnection and policy expiry without running business IO again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-rescheduling-response-')), path = join(dir, 'db.sqlite'); let repository = new SqliteBookings(path); repository.seed(initial);
  try {
    let sends = 0, clocks = 0;
    const app = mount(repository, async () => { sends++; return ok(null); });
    await assert.rejects(async () => { assert((await app.execute(rescheduleBooking, input)).ok); throw new Error('ResponseLost'); }, /ResponseLost/);
    repository.close(); repository = new SqliteBookings(path);
    const observed = observedRepository(repository);
    const restarted = mount(observed.repository, async () => { sends++; return ok(null); }, initial.owner, () => { clocks++; return initial.startsAt + 100 * hour; }, 48);
    const result = await restarted.executeDetailed(rescheduleBooking, input);
    assert.deepEqual(result.result, ok({ kind: 'replayed', value: { ...initial, startsAt: input.startsAt } }));
    assert.equal(result.attempt, null); assert.equal(observed.counts.loads, 0); assert.equal(observed.counts.saves, 0); assert.equal(clocks, 0);
    assert.equal(result.publications.length, 0); assert.equal(sends, 1); assert.equal(repository.pending().length, 1);
    assert.equal(repository.db.prepare('SELECT count(*) AS n FROM booking_rescheduling_receipts').get()?.n, 1);
  } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('receipt failure rolls back state and events; corrupted or mismatched receipts fail closed without executing the operation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-rescheduling-rollback-')), repository = new SqliteBookings(join(dir, 'db.sqlite')); repository.seed(initial);
  try {
    let sends = 0;
    const observed = observedRepository(repository), app = mount(observed.repository, async () => { sends++; return ok(null); });
    repository.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON booking_rescheduling_receipts BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
    const failed = await app.executeDetailed(rescheduleBooking, input);
    assert.deepEqual(failed.result, err('StorageFailed')); assert.equal(failed.publications.length, 0); assert.equal(sends, 0); assert.equal(repository.pending().length, 0);
    assert.deepEqual(await repository.load(input), ok(initial)); assert.equal(repository.db.prepare('SELECT count(*) AS n FROM booking_rescheduling_receipts').get()?.n, 0);
    repository.db.exec('DROP TRIGGER reject_receipt');
    assert((await app.execute(rescheduleBooking, input)).ok);
    const before = { ...observed.counts };
    for (const payload of ['{', JSON.stringify({ ...initial, startsAt: input.startsAt + hour }), JSON.stringify({ ...initial, id: 'other', startsAt: input.startsAt }), JSON.stringify({ ...initial, owner: 'other', startsAt: input.startsAt })]) {
      repository.db.prepare('UPDATE booking_rescheduling_receipts SET data=? WHERE request_id=?').run(payload, input.requestId);
      const replay = await app.executeDetailed(rescheduleBooking, input);
      assert.deepEqual(replay.result, err('StorageFailed')); assert.equal(replay.attempt, null);
    }
    assert.equal(observed.counts.loads, before.loads); assert.equal(observed.counts.saves, before.saves); assert.equal(repository.pending().length, 1); assert.equal(sends, 1);
  } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('composed access policy can revoke receipt access without changing rescheduling, storage or notification wiring', async () => {
  const Permission = createContext<boolean>();
  let lookups = 0, reads = 0, saves = 0, sends = 0;
  const memory = memoryBookings([initial]);
  const repository: ReschedulingRepository = {
    ...memory,
    async reschedulingReceipt(...args) { lookups++; return memory.reschedulingReceipt(...args); },
    async load(input) { reads++; return memory.load(input); },
    async reschedule(...args) { saves++; return memory.reschedule(...args); },
  };
  const template = createApplicationTemplate(<Fragment>
    <Guard useCheck={() => { const allowed = useContext(Permission); return () => allowed ? ok(undefined) : err('ReschedulingDisabled'); }}>
      <ReschedulingBusiness repository={repository} clock={() => now} noticeHours={24} />
    </Guard>
    <ReschedulingNotifications sender={{ send: async () => { sends++; return ok(null); } }} />
  </Fragment>);
  const scope = (allowed: boolean, id = initial.owner) => template.scope(children =>
    <ActorContext.Provider value={{ id, role: 'member' }}><Permission.Provider value={allowed}>{children}</Permission.Provider></ActorContext.Provider>);
  const allowed = scope(true), revoked = scope(false);
  assert.deepEqual([lookups, reads, saves, sends], [0, 0, 0, 0]);
  const first = await allowed.execute(rescheduleBooking, input);
  assert(first.ok && first.value.kind === 'committed');
  assert.deepEqual([lookups, reads, saves, sends], [1, 1, 1, 1]);
  const before = [lookups, reads, saves, sends];
  await assert.rejects(revoked.execute(rescheduleBooking, input), error => error instanceof ExecutionDenied && error.reason === 'ReschedulingDisabled');
  assert.deepEqual([lookups, reads, saves, sends], before);
  const replay = await allowed.execute(rescheduleBooking, input);
  assert(replay.ok && replay.value.kind === 'replayed');
  assert.deepEqual([lookups, reads, saves, sends], [2, 1, 1, 1]);
  // The wrapper grants access to the operation, not ownership of the booking.
  const foreign = await scope(true, valid(actorId('intruder'))).execute(rescheduleBooking, { ...input, requestId: 'intruder-request', startsAt: input.startsAt + hour });
  assert.deepEqual(foreign, err('Forbidden'));
  assert.equal(saves, 1); assert.equal(sends, 1);
});
