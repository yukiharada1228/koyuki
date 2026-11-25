// Development-only Inspector sampling; never imported by the portable package.
import { Session } from 'node:inspector/promises';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { procurement } from '../src/experiments/procurement/application.ts';
import { MemoryProcurement } from '../src/experiments/procurement/repository.ts';
import { story, actor, policy } from '../src/experiments/procurement/comparison-scenario.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
async function main() {
  const phase = process.argv[2], iterations = Number(process.argv[3] ?? (phase === 'construct' ? 1000 : 100));
  if (!['construct', 'execute'].includes(phase) || !Number.isSafeInteger(iterations) || iterations < 1 || process.argv.length > 5) throw new Error('Usage: node --expose-gc --import tsx scripts/profile-procurement.mjs construct|execute [iterations] [raw-directory]');
  const directory = process.argv[4] ? resolve(process.argv[4]) : mkdtempSync(join(tmpdir(), 'koyuki-profile-'));
  mkdirSync(directory, { recursive: true });
  const files = ['src/framework', 'src/experiments/procurement'].flatMap(path => readdirSync(join(root, path)).filter(name => name.endsWith('.ts')).map(name => `${path}/${name}`)).sort();
  const hashes = Object.fromEntries(files.map(path => [path, hash(readFileSync(join(root, path)))]));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) throw new Error('Cannot identify profile source');
  const forbidden = { read() { throw Error('ConstructionMustNotRead'); }, related() { throw Error('ConstructionMustNotRead'); }, async commit() { throw Error('ConstructionMustNotSave'); } };
  const build = repository => [procurement(repository, actor('buyer'), policy), procurement(repository, actor('approver'), policy),
    procurement(repository, actor('approver', 'other'), policy), procurement(repository, actor('warehouse'), policy), procurement(repository, actor('finance'), policy)];
  for (let i = 0; i < 20; i++) await story(procurement, new MemoryProcurement());
  const expected = await story(procurement, new MemoryProcurement());
  // Real app construction is outside the execution profile. The story's factory
  // simply supplies these identity-bound declarations in its original order.
  const prepared = phase === 'execute' ? Array.from({ length: iterations }, () => { const repository = new MemoryProcurement(); return { repository, apps: build(repository) }; }) : [];
  const forcedGcBefore = typeof globalThis.gc === 'function';
  if (forcedGcBefore) globalThis.gc();
  const session = new Session(); session.connect(); let profile; const results = [];
  try {
    await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 100 }); await session.post('Profiler.start');
    try {
      if (phase === 'construct') { let sink; for (let i = 0; i < iterations; i++) sink = build(forbidden); assert.equal(sink.length, 5); }
      else {
        for (const { repository, apps } of prepared) { let index = 0; results.push(await story(() => apps[index++], repository)); assert.equal(index, 5); }
        // Delay complete output comparison until after sampling; story still
        // performs its small final invariant checks inside this profile scope.
      }
    } finally { ({ profile } = await session.post('Profiler.stop')); }
  } finally { session.disconnect(); }
  for (const result of results) assert.deepEqual(result, expected);
  for (const path of files) assert.equal(hash(readFileSync(join(root, path))), hashes[path], 'Profile source changed during execution');
  const bytes = JSON.stringify(profile), filename = `${phase}.cpuprofile`;
  writeFileSync(join(directory, filename), bytes, { flag: 'wx' });
  const normalize = url => url.startsWith('file://' + root) ? url.slice(('file://' + root).length) : url.startsWith(root) ? url.slice(root.length) : url.startsWith('node:') ? url : '(runtime/external)';
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), totals = new Map(); let sampledUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = nodes.get(profile.samples[i]).callFrame, us = profile.timeDeltas[i] ?? 0;
    const key = JSON.stringify([normalize(frame.url), frame.functionName.replaceAll(root, '<repository>/')]);
    totals.set(key, (totals.get(key) ?? 0) + us); sampledUs += us;
  }
  const frames = [...totals].map(([key, us]) => { const [url, name] = JSON.parse(key); return { url, name, us, percent: sampledUs ? 100 * us / sampledUs : 0 }; }).sort((a, b) => b.us - a.us);
  console.log(JSON.stringify({ schema: 'koyuki.procurement-profile.v1', phase, iterations, node: process.version, samplingIntervalUs: 100, forcedGcBefore,
    source: { gitCommit: git.stdout.trim(), hashes, collectionScriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))) },
    samples: profile.samples.length, sampledUs, rawProfile: { filename, sha256: hash(bytes) }, topSelf: frames.slice(0, 25), frameworkSelf: frames.filter(frame => frame.url.startsWith('src/framework/')).slice(0, 20) }, null, 2));
  console.error(`Raw profile retained locally: ${join(directory, filename)}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
