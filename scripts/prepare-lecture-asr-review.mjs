// Prepare local side-by-side source text; never infer review or semantic correctness.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const allVideos = ['izV1h6o3hgQ', 'qBf910_YiqA', 'w0oLNoGsGLc'];
const hash = value => createHash('sha256').update(value).digest('hex');
function main() {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4 || args.length === 4 && !allVideos.includes(args[3])) throw Error('Usage: node scripts/prepare-lecture-asr-review.mjs saved-caption-directory asr-output-directory new-review-directory [completed-video-id]');
  const [captions, asr, output] = args.slice(0, 3).map(path => resolve(path));
  if (existsSync(output)) throw Error('Review output must be new; existing review notes are never overwritten');
  const manifestBytes = readFileSync(join(asr, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 'koyuki.lecture-local-asr.v1' || !Array.isArray(manifest.videos)) throw Error('Invalid ASR manifest');
  const videos = args[3] ? [args[3]] : allVideos;
  if (!args[3] && manifest.status !== 'completed') throw Error('Full ASR job is not complete; select only an already completed video explicitly');
  const prepared = [], contextSeconds = 10;
  for (const videoId of videos) {
    const matches = manifest.videos.filter(item => item.videoId === videoId);
    if (matches.length !== 1) throw Error(`No unique completed ASR record for ${videoId}`);
    const entry = matches[0];
    if (entry.transcriptFile !== `${videoId}.json`) throw Error('Unexpected transcript filename');
    const transcriptBytes = readFileSync(join(asr, `${videoId}.json`));
    if (hash(transcriptBytes) !== entry.transcriptSha256) throw Error('ASR transcript differs from completed record');
    const auditBytes = readFileSync(join(root, 'docs/lecture-audits', `${videoId}.json`));
    const audit = JSON.parse(auditBytes);
    if (audit.source.file !== `${videoId}.ja-orig.txt`) throw Error('Unexpected caption filename');
    const captionBytes = readFileSync(join(captions, audit.source.file));
    if (hash(captionBytes) !== audit.source.sha256) throw Error('Saved captions differ from audited source');
    const captionLines = captionBytes.toString('utf8').trimEnd().split('\n').map(line => {
      const match = line.match(/^(\d\d):(\d\d):(\d\d\.\d+) (.*)$/);
      if (!match) throw Error('Malformed saved caption line');
      return { seconds: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]), line };
    });
    if (captionLines.length !== audit.source.lineCount) throw Error('Caption count differs');
    const transcript = JSON.parse(transcriptBytes).transcription;
    if (!Array.isArray(transcript) || transcript.length !== entry.segments) throw Error('ASR segment count differs');
    const segments = transcript.map((segment, index) => {
      const from = segment.offsets?.from, to = segment.offsets?.to;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || typeof segment.text !== 'string') throw Error(`Invalid ASR timing/text at segment ${index}`);
      return { from: from / 1000, to: to / 1000, text: segment.text };
    });
    for (const section of audit.sections) {
      const start = Math.max(0, section.startSeconds - contextSeconds), end = section.endSeconds + contextSeconds;
      const selectedCaptions = captionLines.filter(line => start <= line.seconds && line.seconds < end);
      const selectedAsr = segments.filter(segment => segment.from < end && segment.to > start);
      const file = `${section.id}.md`;
      const content = `# ${videoId} / ${section.id}: ${section.topic}\n\n` +
        `Topic: ${section.startSeconds}–${section.endSeconds}s; context: ${contextSeconds}s. Automatic texts only; not verified speech or direct listening.\n\n` +
        `## Saved automatic captions\n\n${selectedCaptions.map(line => line.line).join('\n')}\n\n` +
        `## Separate local ASR\n\n${selectedAsr.map(segment => `[${segment.from.toFixed(3)}–${segment.to.toFixed(3)}] ${segment.text}`).join('\n')}\n`;
      prepared.push({ file, content, record: { videoId, sectionId: section.id, startSeconds: section.startSeconds, endSeconds: section.endSeconds,
        captionLines: selectedCaptions.length, asrSegments: selectedAsr.length, reviewFile: file, reviewFileSha256: hash(content),
        captionSourceSha256: audit.source.sha256, asrSourceSha256: entry.transcriptSha256,
        auditSourceSha256: hash(auditBytes),
        textComparisonReviewed: false, audioDirectlyReviewed: false, allFramesReviewed: false } });
    }
  }
  // Validate every selected source before creating output, so a failed prerequisite
  // cannot look like a partially prepared full review.
  mkdirSync(output);
  for (const { file, content } of prepared) writeFileSync(join(output, file), content, { flag: 'wx' });
  writeFileSync(join(output, 'asr-manifest-snapshot.json'), manifestBytes, { flag: 'wx' });
  const summary = { schema: 'koyuki.lecture-asr-review-preparation.v1', createdAt: new Date().toISOString(),
    collectorSha256: hash(readFileSync(fileURLToPath(import.meta.url))), asrManifestSha256: hash(manifestBytes), asrManifestSnapshot: 'asr-manifest-snapshot.json',
    selectedVideos: videos, fullAsrJobStatus: manifest.status, contextSeconds,
    scope: 'Prepared paired automatic text windows only. No review, accuracy, listening or implementation verdict inferred.',
    sections: prepared.map(item => item.record) };
  writeFileSync(join(output, 'preparation.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ selectedVideos: videos, preparedSections: prepared.length, textComparisonReviewed: false, audioDirectlyReviewed: false }));
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
