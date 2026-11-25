// Development evidence only. Reads immutable Git trees; never edits or executes their source.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'src/experiments/procurement/';
const sourceGroups = {
  'domain-rules': ['domain.ts', 'inventory.ts'],
  'host-context': ['context.ts'],
  'loader-experiment': ['context-process.ts', 'context-application.ts'],
  'koyuki-orchestration': ['application.ts'],
  'plain-orchestration': ['plain.ts'],
  'helper-orchestration': ['helper.ts'],
  persistence: ['repository.ts', 'sqlite.ts'],
  replay: ['replay.ts', 'replay-identity.ts', 'baseline-replay.ts'],
  projection: ['projection.ts', 'current-projection.ts', 'baseline-application.ts'],
};
const groups = ['framework', ...Object.keys(sourceGroups), 'tests', 'tooling', 'documentation'];
function category(path) {
  if (path.startsWith('src/framework/')) return 'framework';
  for (const [name, files] of Object.entries(sourceGroups)) if (files.some(file => path === prefix + file)) return name;
  if (/^src\/[^/]+\.test\.tsx?$/.test(path)) return 'tests';
  if (path.startsWith('scripts/')) return 'tooling';
  if (path.startsWith('docs/')) return 'documentation';
  throw new Error(`Unclassified change: ${path}`);
}
function git(repository, args) {
  return execFileSync('git', ['--no-pager', ...args], { cwd: repository, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fingerprint(bytes) {
  const text = bytes.toString('utf8');
  assert(Buffer.from(text, 'utf8').equals(bytes), 'Measurement requires UTF-8 source');
  return { bytes: bytes.length, physicalLines: text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0), sha256: hash(bytes) };
}
function tree(repository, revision) {
  const entries = git(repository, ['ls-tree', '-r', '-z', revision]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const [mode, type] = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), { mode, type }];
  });
  const known = new Map(entries), paths = entries.map(([path]) => path);
  const cache = new Map();
  return { paths, file(path) {
    if (!known.has(path)) return null;
    if (!cache.has(path)) {
      const { mode, type } = known.get(path);
      assert(type === 'blob' && ['100644', '100755'].includes(mode), `Only regular tracked files are measured: ${path}`);
      cache.set(path, { mode, ...fingerprint(git(repository, ['show', `${revision}:${path}`])) });
    }
    return cache.get(path);
  } };
}
export function measureStudy(repository, study) {
  assert(typeof study.name === 'string' && study.name.length > 0);
  for (const revision of [study.before, study.after]) {
    assert.match(revision, /^[0-9a-f]{40}$/, 'Use immutable full commit IDs');
    assert.equal(git(repository, ['rev-parse', `${revision}^{commit}`]).toString().trim(), revision);
  }
  git(repository, ['merge-base', '--is-ancestor', study.before, study.after]);
  const before = tree(repository, study.before), after = tree(repository, study.after);
  const raw = git(repository, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', '--no-indent-heuristic', '--numstat', '-z', study.before, study.after]).toString('utf8');
  const changes = raw.split('\0').filter(Boolean).map(row => {
    const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
    const added = row.slice(0, first), deleted = row.slice(first + 1, second), path = row.slice(second + 1);
    assert(/^\d+$/.test(added) && /^\d+$/.test(deleted), `Binary or invalid diff: ${path}`);
    return { path, category: category(path), added: Number(added), deleted: Number(deleted), before: before.file(path), after: after.file(path) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const totals = groups.map(name => {
    const selected = changes.filter(change => change.category === name);
    return { category: name, changedFiles: selected.length, added: selected.reduce((sum, change) => sum + change.added, 0), deleted: selected.reduce((sum, change) => sum + change.deleted, 0) };
  });
  const unchanged = study.unchanged.map(name => {
    assert(name === 'framework' || Object.hasOwn(sourceGroups, name), `Unknown source group: ${name}`);
    const select = source => source.paths.filter(path => name === 'framework' ? path.startsWith('src/framework/') : sourceGroups[name].some(file => path === prefix + file)).sort();
    const left = select(before), right = select(after);
    assert(left.length > 0 && right.length > 0, `Empty invariant group: ${name}`);
    const entries = (source, paths) => paths.map(path => [path, source.file(path).mode, source.file(path).sha256]);
    const beforeDigest = hash(JSON.stringify(entries(before, left))), afterDigest = hash(JSON.stringify(entries(after, right)));
    assert.equal(afterDigest, beforeDigest, `Changed invariant group: ${name}`);
    return { category: name, files: left.length, digest: beforeDigest };
  });
  return { name: study.name, before: study.before, after: study.after, totals, unchanged, changes };
}
export function measureCases(repository, cases) {
  return { schemaVersion: 1,
    scope: 'Retrospective physical Git diff for two fixed specification changes. Includes every changed tracked file, with shared work counted once. Not total implementation cost, developer effort, semantic change count, productivity, or an OSS quality score.',
    counting: 'Git numstat using Myers without the indent heuristic, external diff, text conversion, or rename detection; physical lines include blanks/comments. Regular tracked file fingerprints include mode, UTF-8 bytes and SHA-256. Missing files are null. No timestamps or working-tree content are measured.',
    studies: cases.map(study => measureStudy(repository, study)),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Use no arguments to print, or --check to verify the saved report');
  const cases = JSON.parse(readFileSync(resolve(root, 'scripts/studies/procurement-change-cases.json'), 'utf8'));
  const report = measureCases(root, cases);
  if (args[0] === '--check') {
    assert.deepEqual(report, JSON.parse(readFileSync(resolve(root, 'docs/procurement-change-metrics.json'), 'utf8')), 'Saved change report is stale');
    console.log(`Verified ${report.studies.length} immutable change studies; every changed file classified, all declared source groups unchanged.`);
  } else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
