import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { measureStudy } from './measure-procurement-changes.mjs';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-metrics-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--object-format=sha1'); git('config', 'user.name', 'Measurement Test'); git('config', 'user.email', 'measurement@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, '.git', 'no-hooks')); git('config', 'core.hooksPath', join(dir, '.git', 'no-hooks'));
  const write = (path, contents) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), contents); };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  return { dir, git, write, commit, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const rules = 'src/experiments/procurement/domain.ts';
test('change measurements include additions, deletions and support work, independent of the working tree', () => {
  const f = fixture();
  try {
    f.write(rules, 'old\nline\n'); f.write('src/framework/index.ts', 'stable\n'); f.write('docs/removed.md', 'remove\n');
    const before = f.commit();
    f.write(rules, 'new\nline\nextra'); f.write('docs/new.md', 'documentation\n'); f.write('scripts/check.mjs', 'tool\n');
    f.write('src/change.test.ts', 'test\n'); rmSync(join(f.dir, 'docs/removed.md'));
    const after = f.commit(), study = { name: 'fixture', before, after, unchanged: ['framework'] };
    const report = measureStudy(f.dir, study);
    assert.equal(report.changes.length, 5);
    const domain = report.changes.find(change => change.path === rules);
    assert.equal(domain.added, 2); assert.equal(domain.deleted, 1);
    assert.equal(domain.before.physicalLines, 2); assert.equal(domain.after.physicalLines, 3);
    assert.equal(domain.before.bytes, 9); assert.equal(domain.after.bytes, 14);
    assert.equal(domain.after.mode, '100644');
    const removed = report.changes.find(change => change.path === 'docs/removed.md');
    assert.equal(removed.after, null); assert.equal(removed.deleted, 1);
    assert.equal(report.changes.find(change => change.path === 'docs/new.md').before, null);
    assert.equal(report.totals.find(row => row.category === 'documentation').changedFiles, 2);
    assert.equal(report.totals.find(row => row.category === 'tooling').changedFiles, 1);
    assert.equal(report.totals.find(row => row.category === 'tests').changedFiles, 1);
    assert.equal(report.totals.find(row => row.category === 'framework').changedFiles, 0);
    assert.equal(report.unchanged[0].files, 1);
    f.write(rules, 'uncommitted data is not this study');
    assert.deepEqual(measureStudy(f.dir, study), report);
  } finally { f.close(); }
});
test('declared unchanged groups reject source changes, additions and executable-mode changes', () => {
  for (const change of ['contents', 'addition', 'mode']) {
    const f = fixture();
    try {
      f.write('src/framework/index.ts', 'stable\n'); const before = f.commit();
      if (change === 'contents') f.write('src/framework/index.ts', 'changed\n');
      else if (change === 'addition') f.write('src/framework/extra.ts', 'extra\n');
      else f.git('update-index', '--chmod=+x', 'src/framework/index.ts');
      // A staged mode change must not be replaced by git add's working-tree mode.
      let after;
      if (change === 'mode') { f.git('commit', '-qm', 'mode'); after = f.git('rev-parse', 'HEAD'); } else after = f.commit();
      assert.throws(() => measureStudy(f.dir, { name: 'fixture', before, after, unchanged: ['framework'] }), /Changed invariant group/);
    } finally { f.close(); }
  }
});
test('unclassified and binary changes fail rather than disappearing from totals', () => {
  for (const [path, contents, expected] of [
    ['src/unclassified.ts', 'unknown\n', /Unclassified change/],
    [rules, Buffer.from([0, 1, 2]), /Binary or invalid diff/],
  ]) {
    const f = fixture();
    try {
      f.write(rules, 'before\n'); const before = f.commit(); f.write(path, contents); const after = f.commit();
      assert.throws(() => measureStudy(f.dir, { name: 'fixture', before, after, unchanged: [] }), expected);
    } finally { f.close(); }
  }
});
test('empty invariant groups and mutable revision names cannot claim verified source identity', () => {
  const f = fixture();
  try {
    f.write(rules, 'before\n'); const before = f.commit(); f.write(rules, 'after\n'); const after = f.commit();
    assert.throws(() => measureStudy(f.dir, { name: 'fixture', before, after, unchanged: ['framework'] }), /Empty invariant group/);
    assert.throws(() => measureStudy(f.dir, { name: 'fixture', before, after: 'HEAD', unchanged: [] }), /immutable full commit IDs/);
  } finally { f.close(); }
});
