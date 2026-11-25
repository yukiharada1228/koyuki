// Check source identity, timing coverage and evidence paths. Does NOT validate interpretations.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = process.argv[2];
if (!sourceDir) throw new Error('Pass the directory containing the saved *.ja-orig.txt files');
const audits = join(root, 'docs/lecture-audits');
const statuses = new Set(['supported', 'partial', 'gap', 'design-choice', 'experience', 'context']);
for (const file of readdirSync(audits).filter(file => file.endsWith('.json'))) {
  const audit = JSON.parse(readFileSync(join(audits, file), 'utf8'));
  const bytes = readFileSync(join(sourceDir, audit.source.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), audit.source.sha256, `${file}: source differs`);
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  assert.equal(lines.length, audit.source.lineCount);
  const assigned = new Map(audit.sections.map(section => [section.id, 0]));
  assert.equal(assigned.size, audit.sections.length, 'duplicate section ID');
  let end = 0;
  for (const section of audit.sections) {
    assert.equal(section.startSeconds, end, `${section.id}: gap or overlap`);
    assert(section.endSeconds > section.startSeconds);
    assert(statuses.has(section.status));
    if (section.status === 'gap' || section.status === 'partial') assert(section.remaining.length > 0);
    for (const target of section.evidence) {
      const path = resolve(root, target);
      assert(path.startsWith(`${root}/`) && existsSync(path), `${section.id}: missing evidence path ${target}`);
    }
    end = section.endSeconds;
  }
  assert.equal(end, audit.source.durationSeconds);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(\d\d):(\d\d):(\d\d\.\d+) /);
    assert(match, `invalid caption line ${index + 1}`);
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const owners = audit.sections.filter(section => section.startSeconds <= seconds && seconds < section.endSeconds);
    assert.equal(owners.length, 1, `caption line ${index + 1} must have exactly one topic`);
    assigned.set(owners[0].id, assigned.get(owners[0].id) + 1);
  }
  for (const [id, count] of assigned) assert(count > 0, `${id}: no caption lines`);
  console.log(JSON.stringify({ videoId: audit.videoId, captionLinesAssigned: lines.length, topics: audit.sections.length,
    scope: 'Structural coverage of saved captions only; semantic interpretation, audio, frames and implementation completeness are NOT automatically verified.' }));
}
