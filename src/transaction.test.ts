import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncTransaction, TransactionFailure, ok, err, type SyncTransactionDriver, type TransactionEvent, type Result } from './framework/index.js';

function fixture() {
  const events: TransactionEvent[] = [], calls: string[] = [];
  const driver = {
    begin: () => { calls.push('begin'); },
    commit: () => { calls.push('commit'); },
    rollback: () => { calls.push('rollback'); },
  } satisfies SyncTransactionDriver;
  return { driver, events, calls };
}
test('transaction preserves union results and observes exactly one commit', () => {
  const f = fixture(), tx = createSyncTransaction(f.driver, e => { f.events.push(e); throw Error('observer'); });
  const value = ok({ id: 'x' });
  assert.equal(tx.run(() => value), value);
  const choose = (n: number) => n === 0 ? err('Zero' as const) : n < 0 ? err('Negative' as const) : ok(n);
  const result: Result<number, 'Zero' | 'Negative'> = tx.run(() => choose(0));
  assert.deepEqual(result, err('Zero'));
  assert.deepEqual(f.calls, ['begin', 'commit', 'begin', 'rollback']);
  assert.deepEqual(f.events.map(e => e.kind), ['started', 'committed', 'started', 'rolled-back']);
});
test('work exception rolls back, keeps cause and permits an explicit later attempt', () => {
  const f = fixture(), tx = createSyncTransaction(f.driver), cause = Error('work');
  assert.throws(() => tx.run(() => { throw cause; }), e => e instanceof TransactionFailure && e.phase === 'work' && e.outcome === 'rolled-back' && e.cause === cause);
  assert.deepEqual(tx.run(() => ok(2)), ok(2));
  assert.deepEqual(f.calls, ['begin', 'rollback', 'begin', 'commit']);
});
test('failed begin does not rollback a transaction it did not acquire', () => {
  const f = fixture();
  f.driver.begin = () => { f.calls.push('begin'); throw Error('begin'); };
  const tx = createSyncTransaction(f.driver);
  assert.throws(() => tx.run(() => { assert.fail('must not execute'); }), e => e instanceof TransactionFailure && e.phase === 'begin' && e.outcome === 'not-started');
  assert.deepEqual(f.calls, ['begin']);
});
test('commit error reports unknown outcome and quarantines the boundary', () => {
  const f = fixture(); f.driver.commit = () => { f.calls.push('commit'); throw Error('lost confirmation'); };
  const tx = createSyncTransaction(f.driver);
  assert.throws(() => tx.run(() => ok(1)), e => e instanceof TransactionFailure && e.phase === 'commit' && e.outcome === 'unknown');
  assert.throws(() => tx.run(() => ok(2)), e => e instanceof TransactionFailure && e.phase === 'unusable');
  assert.deepEqual(f.calls, ['begin', 'commit', 'rollback']);
});
test('rollback error quarantines the connection for both failure and exception', () => {
  for (const throws of [false, true]) {
    const f = fixture(); f.driver.rollback = () => { f.calls.push('rollback'); throw Error('rollback'); };
    const tx = createSyncTransaction(f.driver, e => f.events.push(e));
    assert.throws(() => tx.run(() => { if (throws) throw Error('work'); return err('Denied'); }), e => e instanceof TransactionFailure && e.phase === 'rollback' && e.outcome === 'unknown');
    assert.throws(() => tx.run(() => ok(1)), e => e instanceof TransactionFailure && e.phase === 'unusable');
    assert.deepEqual(f.calls, ['begin', 'rollback']);
    assert.equal(f.events.at(-1)?.kind, 'failed');
  }
});
test('nested work cannot open a second transaction or commit the outer one', () => {
  const f = fixture(), tx = createSyncTransaction(f.driver);
  assert.throws(() => tx.run(() => tx.run(() => ok(2))), e => e instanceof TransactionFailure && e.phase === 'work' && e.cause instanceof TransactionFailure && e.cause.phase === 'busy');
  assert.deepEqual(f.calls, ['begin', 'rollback']);
});
test('observer reentry stays blocked through the final event, and does not change success', () => {
  const f = fixture(), rejected: unknown[] = [];
  const tx = createSyncTransaction(f.driver, () => { try { tx.run(() => ok(2)); } catch (error) { rejected.push(error); } });
  assert.deepEqual(tx.run(() => ok(1)), ok(1));
  assert.equal(rejected.length, 2);
  assert(rejected.every(e => e instanceof TransactionFailure && e.phase === 'busy'));
  assert.deepEqual(f.calls, ['begin', 'commit']);
});
test('adapter context and method receiver are preserved', () => {
  const driver = { calls: [] as string[], begin(mode: 'read' | 'write' | undefined): undefined { this.calls.push(mode ?? 'write'); }, commit(): undefined { this.calls.push('commit'); }, rollback(): undefined { this.calls.push('rollback'); } };
  const tx = createSyncTransaction(driver);
  tx.run(() => ok(1), 'read');
  assert.deepEqual(driver.calls, ['read', 'commit']);
  if (false) {
    // @ts-expect-error synchronous transaction must reject asynchronous work
    tx.run(async () => ok(1));
    // @ts-expect-error context belongs to the adapter
    tx.run(() => ok(1), 'other');
    // @ts-expect-error asynchronous driver hooks are unsupported
    createSyncTransaction({ begin: async () => {}, commit: () => {}, rollback: () => {} });
  }
});

test('real SQLite rolls back writes on Result failure and deferred commit failure', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
    const tx = createSyncTransaction({ begin: () => { db.exec('BEGIN IMMEDIATE'); }, commit: () => { db.exec('COMMIT'); }, rollback: () => { db.exec('ROLLBACK'); } });
    assert.deepEqual(tx.run(() => { db.exec('INSERT INTO parent VALUES(1)'); return err('Denied'); }), err('Denied'));
    assert.equal(db.prepare('SELECT count(*) n FROM parent').get()?.n, 0);
    assert.throws(() => tx.run(() => { db.exec('INSERT INTO parent VALUES(1); INSERT INTO child VALUES(2)'); return ok(1); }), e => e instanceof TransactionFailure && e.phase === 'commit' && e.outcome === 'unknown');
    // This driver can inspect its own database after rollback; the portable boundary
    // still does not generalize this observation to every driver's failed commit.
    assert.equal(db.prepare('SELECT count(*) n FROM parent').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM child').get()?.n, 0);
  } finally { db.close(); }
});
