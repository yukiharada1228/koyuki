import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = ['check-lecture-audit.mjs', 'check-lecture-decks.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'koyuki-record-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'docs/lecture-audits', 'docs/lecture-deck-audits', 'src']) mkdirSync(join(root, dir), { recursive: true });
  for (const script of scripts) copyFileSync(join(repo, 'scripts', script), join(root, 'scripts', script));
  writeFileSync(join(root, 'src/evidence.ts'), '// Test-only evidence placeholder; no semantic review is asserted.');
  const caption = '00:00:00.000 Example caption\n', pdf = '%PDF-1.7\n';
  const manifests = [];
  for (const videoId of ['a', 'b', 'c']) {
    const item = { topic: 'Example', status: 'supported', assessment: 'Fixture only.', evidence: ['src/evidence.ts'], remaining: [] };
    writeFileSync(join(root, `docs/lecture-audits/${videoId}.json`), JSON.stringify({ videoId,
      source: { file: `${videoId}.txt`, sha256: hash(caption), lineCount: 1, durationSeconds: 10 },
      sections: [{ ...item, id: `${videoId}-01`, startSeconds: 0, endSeconds: 10 }],
    }));
    manifests.push({ videoId, source: { file: `decks/${videoId}.pdf`, sha256: hash(pdf), pageCount: 1 },
      review: { allPagesReviewed: true, visuallyReviewedPages: [1], auditFile: `docs/lecture-deck-audits/${videoId}.json` } });
    writeFileSync(join(root, `docs/lecture-deck-audits/${videoId}.json`), JSON.stringify({ videoId, sourceSha256: hash(pdf), review: { allPagesRead: true, allPagesVisuallyInspected: true }, pages: [{ ...item, page: 1 }] }));
  }
  writeFileSync(join(root, 'docs/lecture-decks.json'), JSON.stringify(manifests));
  return { root,
    run(script, ...args) { return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8' }); },
    change(path, update) { const file = join(root, path), data = JSON.parse(readFileSync(file, 'utf8')); update(data); writeFileSync(file, JSON.stringify(data)); },
    originals() {
      const dir = join(root, 'originals'); mkdirSync(join(dir, 'decks'), { recursive: true });
      for (const id of ['a', 'b', 'c']) { writeFileSync(join(dir, `${id}.txt`), caption); writeFileSync(join(dir, `decks/${id}.pdf`), pdf); }
      return dir;
    },
  };
}
function success(result) { assert.equal(result.status, 0, result.stderr); return result.stdout.trim().split('\n').map(line => JSON.parse(line)); }
function failure(result) { assert.notEqual(result.status, 0, 'invalid record unexpectedly passed'); }
test('records-only checks work without originals and never claim source identity or caption assignment', t => {
  const f = fixture(t);
  for (const script of scripts) {
    const rows = success(f.run(script, '--records-only'));
    assert.equal(rows.length, 3);
    for (const row of rows) { assert.equal(row.sourceIdentityVerified, false); assert(!('captionLinesAssigned' in row)); }
    failure(f.run(script)); failure(f.run(script, '--typo')); failure(f.run(script, '--records-only', 'extra'));
  }
});
test('full checks still require original bytes; metadata-only mode does not conceal that distinction', t => {
  const f = fixture(t);
  for (const script of scripts) failure(f.run(script, join(f.root, 'absent')));
  const originals = f.originals();
  for (const script of scripts) for (const row of success(f.run(script, originals))) assert.equal(row.sourceIdentityVerified, true);
  writeFileSync(join(originals, 'a.txt'), '00:00:00.000 Changed caption\n');
  writeFileSync(join(originals, 'decks/a.pdf'), '%PDF-1.7\nChanged');
  for (const script of scripts) { failure(f.run(script, originals)); success(f.run(script, '--records-only')); }
});
test('both modes reject missing implementation evidence', t => {
  const f = fixture(t); rmSync(join(f.root, 'src/evidence.ts'));
  const originals = f.originals();
  for (const script of scripts) { failure(f.run(script, '--records-only')); failure(f.run(script, originals)); }
});
test('caption records reject gaps and nonfinite intervals independently of the original captions', t => {
  const f = fixture(t);
  f.change('docs/lecture-audits/a.json', data => { data.sections[0].startSeconds = 1; });
  failure(f.run(scripts[0], '--records-only'));
  f.change('docs/lecture-audits/a.json', data => { data.sections[0].startSeconds = 0; data.sections[0].endSeconds = null; });
  failure(f.run(scripts[0], '--records-only'));
});
test('completed page reviews reject missing pages and inconsistent source fingerprints', t => {
  const f = fixture(t);
  const original = JSON.parse(readFileSync(join(f.root, 'docs/lecture-deck-audits/a.json'), 'utf8'));
  f.change('docs/lecture-deck-audits/a.json', data => { data.pages = []; }); failure(f.run(scripts[1], '--records-only'));
  f.change('docs/lecture-deck-audits/a.json', data => { data.pages = original.pages; data.sourceSha256 = '0'.repeat(64); });
  failure(f.run(scripts[1], '--records-only'));
});
test('partial and gap records must name remaining work', t => {
  const f = fixture(t);
  f.change('docs/lecture-audits/a.json', data => { data.sections[0].status = 'partial'; });
  f.change('docs/lecture-deck-audits/a.json', data => { data.pages[0].status = 'gap'; });
  for (const script of scripts) failure(f.run(script, '--records-only'));
});
test('record source paths cannot escape the declared original directory', t => {
  const f = fixture(t);
  f.change('docs/lecture-audits/a.json', data => { data.source.file = '../escape.txt'; });
  f.change('docs/lecture-decks.json', data => { data[0].source.file = '../escape.pdf'; });
  for (const script of scripts) failure(f.run(script, '--records-only'));
});
test('only full mode verifies that actual caption timestamps belong to a topic', t => {
  const f = fixture(t), originals = f.originals(), caption = '00:00:11.000 Outside the recorded interval\n';
  writeFileSync(join(originals, 'a.txt'), caption);
  f.change('docs/lecture-audits/a.json', data => { data.source.sha256 = hash(caption); });
  success(f.run(scripts[0], '--records-only'));
  const rejected = f.run(scripts[0], originals); failure(rejected);
  assert.match(rejected.stderr, /exactly one topic/);
});
test('a completed manifest cannot contradict its own manual page-review flags', t => {
  const f = fixture(t);
  f.change('docs/lecture-deck-audits/a.json', data => { data.review.allPagesVisuallyInspected = false; });
  failure(f.run(scripts[1], '--records-only'));
});
