import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const meta = JSON.parse(readFileSync('.build/worker/bundle-meta.json', 'utf8'));
for (const output of Object.values(meta.outputs)) assert.equal(output.imports.length, 0, 'Worker has external runtime imports');
for (const input of Object.keys(meta.inputs)) assert(!/node:|unenv|node-polyfill/.test(input), `Node shim: ${input}`);
const base = process.argv[2] ?? 'http://localhost:8794';
const results = await Promise.all(Array.from({ length: 5 }, async () => {
  const response = await fetch(new URL('/check', base)); assert.equal(response.status, 200);
  return response.json();
}));
for (const r of results) {
  assert.equal(r.ok, true); assert.equal(r.normal, 'committed'); assert.equal(r.replay, 'replayed');
  assert.equal(r.rejected, 'InvalidAmount'); assert.equal(r.recovered, 'replayed');
  assert.equal(r.writes, 2); assert.deepEqual(r.current, { value: 5, version: 3 });
  assert.deepEqual(r.recoveryTrace.at(-1), { kind: 'lookup', phase: 'after-error', status: 'found' });
}
console.log(`Verified five independent requests at ${base}; Worker bundle has no external imports or Node shims.`);
