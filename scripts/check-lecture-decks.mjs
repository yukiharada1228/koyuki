// Verify identity of saved originals, not semantic completeness of their review.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];
if (!source) throw new Error('Pass the saved functional-business-talks directory');
const records = JSON.parse(readFileSync(resolve(root, 'docs/lecture-decks.json'), 'utf8'));
assert.equal(new Set(records.map(entry => entry.videoId)).size, 3);
for (const entry of records) {
  const path = resolve(source, entry.source.file);
  assert(path.startsWith(`${resolve(source)}/`));
  const bytes = readFileSync(path);
  assert(bytes.subarray(0, 5).toString() === '%PDF-');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.source.sha256, 'Source PDF differs');
  assert(entry.review.visuallyReviewedPages.every(page => Number.isInteger(page) && page > 0 && page <= entry.source.pageCount));
  if (entry.review.allPagesReviewed) {
    assert.deepEqual(entry.review.visuallyReviewedPages, Array.from({ length: entry.source.pageCount }, (_, i) => i + 1));
    const auditPath = resolve(root, entry.review.auditFile);
    assert(auditPath.startsWith(`${root}/`));
    const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
    assert.equal(audit.videoId, entry.videoId);
    assert.equal(audit.sourceSha256, entry.source.sha256);
    assert.equal(audit.pages.length, entry.source.pageCount);
    assert.deepEqual(audit.pages.map(page => page.page), entry.review.visuallyReviewedPages);
    for (const page of audit.pages) {
      assert(['supported', 'partial', 'gap', 'design-choice', 'experience', 'context'].includes(page.status));
      if (page.status === 'partial' || page.status === 'gap') assert(page.remaining.length > 0);
      for (const evidence of page.evidence) {
        const path = resolve(root, evidence);
        assert(path.startsWith(`${root}/`) && existsSync(path));
      }
    }
  }
  console.log(JSON.stringify({ videoId: entry.videoId, verified: 'saved PDF identity', expectedPages: entry.source.pageCount,
    allPagesReviewed: entry.review.allPagesReviewed, scope: 'Hash and metadata only; not proof of page count, interpretation, audio or implementation completeness.' }));
}
