// Check source identity, timing coverage and evidence paths. Does NOT validate interpretations.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const recordsOnly = args.length === 1 && args[0] === '--records-only';
if (args.length !== 1 || (!recordsOnly && args[0].startsWith('--'))) throw new Error('Pass the saved caption directory, or --records-only for record structure without originals');
const sourceDir = recordsOnly ? null : resolve(args[0]);
const audits = join(root, 'docs/lecture-audits');
const statuses = new Set(['supported', 'partial', 'gap', 'design-choice', 'experience', 'context']);
const files = readdirSync(audits).filter(file => file.endsWith('.json'));
assert.equal(files.length, 3);
const videoIds = new Set();
for (const file of files) {
  const audit = JSON.parse(readFileSync(join(audits, file), 'utf8'));
  assert(typeof audit.videoId === 'string' && audit.videoId.length > 0);
  assert(!videoIds.has(audit.videoId), 'duplicate video ID'); videoIds.add(audit.videoId);
  assert.match(audit.source.sha256, /^[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(audit.source.lineCount) && audit.source.lineCount > 0);
  assert(Number.isFinite(audit.source.durationSeconds) && audit.source.durationSeconds > 0);
  const sourceRoot = sourceDir ?? resolve(root, 'saved-originals');
  const sourcePath = resolve(sourceRoot, audit.source.file);
  assert(sourcePath.startsWith(`${sourceRoot}/`), 'source path escapes its directory');
  let lines = null;
  if (!recordsOnly) {
    const bytes = readFileSync(sourcePath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), audit.source.sha256, `${file}: source differs`);
    lines = bytes.toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, audit.source.lineCount);
  }
  const assigned = new Map(audit.sections.map(section => [section.id, 0]));
  assert.equal(assigned.size, audit.sections.length, 'duplicate section ID');
  let end = 0;
  for (const section of audit.sections) {
    assert.equal(section.startSeconds, end, `${section.id}: gap or overlap`);
    assert(Number.isFinite(section.startSeconds) && Number.isFinite(section.endSeconds) && section.endSeconds > section.startSeconds);
    assert(statuses.has(section.status));
    assert(typeof section.topic === 'string' && section.topic.trim());
    assert(typeof section.assessment === 'string' && section.assessment.trim());
    assert(Array.isArray(section.evidence) && Array.isArray(section.remaining));
    if (section.status === 'gap' || section.status === 'partial') assert(section.remaining.length > 0);
    for (const target of section.evidence) {
      const path = resolve(root, target);
      assert(path.startsWith(`${root}/`) && existsSync(path), `${section.id}: missing evidence path ${target}`);
    }
    end = section.endSeconds;
  }
  assert.equal(end, audit.source.durationSeconds);
  for (const [index, line] of (lines ?? []).entries()) {
    const match = line.match(/^(\d\d):(\d\d):(\d\d\.\d+) /);
    assert(match, `invalid caption line ${index + 1}`);
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const owners = audit.sections.filter(section => section.startSeconds <= seconds && seconds < section.endSeconds);
    assert.equal(owners.length, 1, `caption line ${index + 1} must have exactly one topic`);
    assigned.set(owners[0].id, assigned.get(owners[0].id) + 1);
  }
  if (lines) for (const [id, count] of assigned) assert(count > 0, `${id}: no caption lines`);
  console.log(JSON.stringify({ videoId: audit.videoId, sourceIdentityVerified: !recordsOnly,
    ...(lines ? { captionLinesAssigned: lines.length } : { declaredCaptionLines: audit.source.lineCount }), topics: audit.sections.length,
    scope: recordsOnly ? 'Record structure only; originals, caption assignment, interpretation, audio, frames and implementation completeness are NOT verified.'
      : 'Structural coverage of saved captions only; semantic interpretation, audio, frames and implementation completeness are NOT automatically verified.' }));
}
