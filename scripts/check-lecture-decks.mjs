// Verify identity of saved originals, not semantic completeness of their review.
import { readFileSync } from 'node:fs';
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
  console.log(JSON.stringify({ videoId: entry.videoId, verified: 'saved PDF identity', expectedPages: entry.source.pageCount,
    allPagesReviewed: entry.review.allPagesReviewed, scope: 'Hash and metadata only; not proof of page count, interpretation, audio or implementation completeness.' }));
}
