import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCustomers } from './examples/customer-import/sqlite.js';
import { customerImport } from './examples/customer-import/application.js';
import { validate, decide, type Input, type Decision } from './examples/customer-import/domain.js';
import { err } from './framework/index.js';
const input: Input = { groupId: 'g1', visitor: { name: 'First', email: 'A@example.com' } };
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-customer-')), path = join(directory, 'customers.sqlite');
  const connections: SqliteCustomers[] = [];
  const open = (group = 'g1') => { const repo = new SqliteCustomers(path, group); connections.push(repo); return repo; };
  t.after(() => { for (const repo of connections) { try { repo.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  return { path, open };
}
async function prepare(repo: SqliteCustomers, request: Input): Promise<Decision> {
  const validated = validate(request); assert(validated.ok);
  const identity = await repo.identify(validated.value); assert(identity.ok);
  const decision = decide(identity.value); assert(decision.ok); return decision.value;
}
test('customer import persists across DB connections and a separate OS process', async t => {
  const f = fixture(t), repo = f.open();
  const created = await customerImport(repo).run(input); assert(created.ok); assert.equal(created.value.version, 1);
  repo.close();
  const reopened = f.open();
  assert.deepEqual(await customerImport(reopened).run(input), created);
  const child = `import { SqliteCustomers } from ${JSON.stringify(new URL('./examples/customer-import/sqlite.ts', import.meta.url).href)};
import { customerImport } from ${JSON.stringify(new URL('./examples/customer-import/application.ts', import.meta.url).href)};
const repo = new SqliteCustomers(${JSON.stringify(f.path)}, 'g1');
try { console.log(JSON.stringify(await customerImport(repo).run(${JSON.stringify(input)}))); } finally { repo.close(); }`;
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { encoding: 'utf8' }));
  assert.deepEqual(result, created);
});
test('two absence snapshots cannot create duplicate identities', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  const first = await prepare(a, input), second = await prepare(b, input);
  assert.equal(first.kind, 'created'); assert.equal(second.kind, 'created');
  const winner = await a.save(first); assert(winner.ok);
  assert.deepEqual(await b.save(second), err({ kind: 'Conflict' }));
  assert.deepEqual(await customerImport(b).run(input), winner);
});
test('two update snapshots use CAS and stale unchanged decisions do not return old state', async t => {
  const f = fixture(t), a = f.open(), b = f.open();
  const created = await customerImport(a).run(input); assert(created.ok);
  const unchanged = await prepare(a, input); assert.equal(unchanged.kind, 'unchanged');
  const first = await prepare(a, { ...input, visitor: { name: 'Winner', email: 'a@example.com' } });
  const second = await prepare(b, { ...input, visitor: { name: 'Loser', email: 'a@example.com' } });
  const winner = await a.save(first); assert(winner.ok); assert.equal(winner.value.version, 2);
  assert.deepEqual(await b.save(second), err({ kind: 'Conflict' }));
  assert.deepEqual(await b.save(unchanged), err({ kind: 'Conflict' }));
  assert.deepEqual(await customerImport(b).run({ ...input, visitor: { name: 'Winner', email: 'a@example.com' } }), winner);
});
test('trusted group scope isolates identical emails and rejects mismatched input or save', async t => {
  const f = fixture(t), a = f.open('g1'), b = f.open('g2');
  const first = await customerImport(a).run(input); assert(first.ok);
  assert.deepEqual(await customerImport(a).run({ ...input, groupId: 'g2' }), err({ kind: 'LookupUnavailable' }));
  const other = await prepare(b, { ...input, groupId: 'g2' }); assert.equal(other.kind, 'created');
  assert.deepEqual(await a.save(other), err({ kind: 'Conflict' }));
  const second = await b.save(other); assert(second.ok); assert.notEqual(first.value.id, second.value.id);
});
test('corrupt persisted state is rejected and unexpected storage defects still reject', async t => {
  const f = fixture(t), repo = f.open();
  assert((await customerImport(repo).run(input)).ok);
  const db = new DatabaseSync(f.path);
  db.prepare('UPDATE imported_customers SET name = ?').run(''); db.close();
  assert.deepEqual(await customerImport(repo).run(input), err({ kind: 'LookupUnavailable' }));
  repo.close();
  await assert.rejects(customerImport(repo).run(input));
});

type ImportResult = Awaited<ReturnType<ReturnType<typeof customerImport>['run']>>;
function writer(t: { after(fn: () => void): void }, path: string, request: Input) {
  const code = `import { SqliteCustomers } from ${JSON.stringify(new URL('./examples/customer-import/sqlite.ts', import.meta.url).href)};
import { customerImport } from ${JSON.stringify(new URL('./examples/customer-import/application.ts', import.meta.url).href)};
const repo = new SqliteCustomers(${JSON.stringify(path)}, 'g1');
const go = new Promise(resolve => process.once('message', resolve));
const ports = { identify: async input => {
  const result = await repo.identify(input); process.send({ kind: 'ready' }); await go; return result;
}, save: repo.save };
try {
  const value = await customerImport(ports).run(${JSON.stringify(request)});
  repo.close(); process.send({ kind: 'result', value }, () => process.disconnect());
} catch (cause) {
  try { repo.close(); } catch {}
  process.send({ kind: 'failed', message: String(cause) }, () => { process.exitCode = 1; process.disconnect(); });
}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let diagnostics = '', outcome: ImportResult | undefined;
  child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const done = new Promise<ImportResult>((resolve, reject) => {
    const timer = setTimeout(() => { diagnostics += 'Writer timed out'; child.kill('SIGKILL'); }, 10000);
    child.on('message', message => {
      if (typeof message !== 'object' || message === null) return;
      const value = message as { kind?: unknown; value?: ImportResult; message?: unknown };
      if (value.kind === 'ready') readyResolve();
      if (value.kind === 'result') outcome = value.value;
      if (value.kind === 'failed') diagnostics += String(value.message);
    });
    child.on('error', error => { clearTimeout(timer); readyReject(error); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0 && outcome) resolve(outcome);
      else { const error = new Error(`Writer failed: ${diagnostics}`); readyReject(error); reject(error); }
    });
  });
  // Both phases are awaited below; attach handlers now for early startup failures.
  void ready.catch(() => {}); void done.catch(() => {});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { ready, done, go: () => child.send({ kind: 'go' }) };
}
for (const existing of [false, true]) test(`separate OS writers contend after the same ${existing ? 'version' : 'absence'} snapshot`, async t => {
  const f = fixture(t), repo = f.open();
  if (existing) assert((await customerImport(repo).run(input)).ok);
  const a = writer(t, f.path, { ...input, visitor: { name: 'Writer A', email: 'a@example.com' } });
  const b = writer(t, f.path, { ...input, visitor: { name: 'Writer B', email: 'a@example.com' } });
  await Promise.all([a.ready, b.ready]);
  a.go(); b.go();
  const results = await Promise.all([a.done, b.done]);
  const winners = results.filter(result => result.ok), losers = results.filter(result => !result.ok);
  assert.equal(winners.length, 1); assert.equal(losers.length, 1);
  assert.deepEqual(losers[0], err({ kind: 'Conflict' }));
  const winner = winners[0]; assert(winner?.ok);
  assert.equal(winner.value.version, existing ? 2 : 1);
  const persisted = await customerImport(repo).run({ ...input, visitor: { name: winner.value.name, email: winner.value.email } });
  assert.deepEqual(persisted, winner);
});
