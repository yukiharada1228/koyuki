// Local review preparation only. No upload, transcription, or automatic approval.
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const records = ['iz', 'qbf', 'w0o'].map(name => `docs/lecture-local-asr-${name}-followup.json`);
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function duration(path) {
  const value = Number(capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]));
  if (!Number.isFinite(value) || value <= 0) throw Error('Invalid media duration');
  return value;
}
async function main() {
  if (process.argv.length !== 4) throw Error('Usage: node scripts/prepare-lecture-audio-review.mjs saved-video-directory new-output-directory');
  const [source, output] = process.argv.slice(2).map(path => resolve(path));
  if (existsSync(output)) throw Error('Output must be new; existing review material must not be overwritten');
  const selected = [], sources = [];
  for (const record of records) {
    const path = join(root, record), review = JSON.parse(readFileSync(path, 'utf8'));
    if (!/^[A-Za-z0-9_-]{11}$/.test(review.videoId)) throw Error('Invalid source video ID');
    const video = join(source, `${review.videoId}.mp4`), sourceDuration = duration(video);
    sources.push({ record, recordSha256: await sha256(path), videoId: review.videoId,
      videoFile: `${review.videoId}.mp4`, videoSha256: await sha256(video), durationSeconds: sourceDuration });
    for (const section of review.reviewedSections) {
      for (const interval of section.needsDirectAudio) {
        const { startSeconds, endSeconds, reason } = interval;
        if (!/^[a-z0-9-]+$/.test(section.sectionId) || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
          || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > sourceDuration || typeof reason !== 'string') throw Error('Invalid unresolved interval');
        selected.push({ videoId: review.videoId, sectionId: section.sectionId, startSeconds, endSeconds, reason,
          clipStartSeconds: Math.max(0, startSeconds - 8), clipEndSeconds: Math.min(sourceDuration, endSeconds + 8) });
      }
    }
  }
  if (!selected.length) throw Error('No unresolved intervals; do not create an empty review');
  const ffmpegVersion = capture('ffmpeg', ['-version']).split('\n')[0];
  mkdirSync(output);
  const manifest = { schema: 'koyuki.lecture-audio-review-preparation.v1', status: 'preparing', createdAt: new Date().toISOString(),
    collectorSha256: await sha256(fileURLToPath(import.meta.url)), ffmpegVersion, sources,
    audioDirectlyReviewed: false, allFramesReviewed: false,
    scope: 'Prepared decoded audio clips only. No speech verified, no automatic transcript, no lecture or implementation completion claim.', clips: [] };
  const save = () => writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();
  for (const [index, interval] of selected.entries()) {
    const file = `${String(index + 1).padStart(2, '0')}-${interval.sectionId}.wav`, path = join(output, file);
    const seconds = interval.clipEndSeconds - interval.clipStartSeconds;
    capture('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-ss', String(interval.clipStartSeconds),
      '-i', join(source, `${interval.videoId}.mp4`), '-t', String(seconds), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', path]);
    const actualDurationSeconds = duration(path);
    if (Math.abs(actualDurationSeconds - seconds) > 0.15) throw Error(`Unexpected clip duration: ${file}`);
    manifest.clips.push({ ...interval, file, sha256: await sha256(path), actualDurationSeconds, audioDirectlyReviewed: false });
    save();
  }
  const template = { schema: 'koyuki.lecture-audio-review-submission.v1', preparationManifestSha256: null,
    reviewer: null, reviewedAt: null, scope: 'Human review draft; not automatically imported into lecture evidence.',
    clips: manifest.clips.map(clip => ({ file: clip.file, sha256: clip.sha256, sectionId: clip.sectionId,
      status: 'pending', heardText: null, interpretation: null, implementationImpact: null })) };
  const rows = manifest.clips.map(clip => `| [${clip.file}](${clip.file}) | ${clip.videoId} / ${clip.sectionId} | ${clip.startSeconds}–${clip.endSeconds} | ${clip.reason} |`).join('\n');
  writeFileSync(join(output, 'README.md'), `# 原音確認用クリップ（未確認）\n\n前後8秒を含む音声です。音声認識・意味の確定・全編視聴は行っていません。\n再生して前後を聞き、判別できた語と解釈・実装への影響をreview-template.jsonへ記録してください。\n不明なものはpendingまたはunclearのまま残し、聞いた範囲以上の確認を記入しないでください。\n元動画・対応表・クリップのhashはmanifest.jsonに記録しています。転載・アップロードはしていません。\n\n| クリップ | 動画・話題 | 要確認の元時刻（秒） | 未確認の理由 |\n| --- | --- | --- | --- |\n${rows}\n\n確認票は下書きであり、講演対応表を自動更新しません。\n`);
  manifest.status = 'prepared'; save();
  template.preparationManifestSha256 = await sha256(join(output, 'manifest.json'));
  writeFileSync(join(output, 'review-template.json'), JSON.stringify(template, null, 2) + '\n');
  console.log(JSON.stringify({ output, clips: manifest.clips.length,
    totalSeconds: manifest.clips.reduce((sum, clip) => sum + clip.actualDurationSeconds, 0), audioDirectlyReviewed: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
