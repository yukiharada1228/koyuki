import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
