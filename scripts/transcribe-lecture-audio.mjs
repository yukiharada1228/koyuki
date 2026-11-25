// Local source-audit tooling, outside the portable framework. Never uploads audio.
import { createReadStream, openSync, closeSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const videos = ['izV1h6o3hgQ', 'qBf910_YiqA', 'w0oLNoGsGLc'];
const expectedModelSha1 = 'e050f7970618a659205450ad97eb95a18d69c9ee';
async function digest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
function capture(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? Error(result.stderr || result.stdout);
  return (result.stdout + result.stderr).trim();
}
function logged(program, args, path) {
  const fd = openSync(path, 'wx');
  try {
    const result = spawnSync(program, args, { stdio: ['ignore', fd, fd] });
    if (result.error || result.status !== 0) throw result.error ?? Error(`${program} failed (${result.status}, ${result.signal}); inspect local log`);
  } finally { closeSync(fd); }
}
async function main() {
  if (process.argv.length !== 5) throw Error('Usage: node scripts/transcribe-lecture-audio.mjs saved-video-directory ggml-large-v3-turbo-q5_0.bin new-output-directory');
  const [source, model, output] = process.argv.slice(2).map(path => resolve(path));
  for (const id of videos) if (!existsSync(join(source, `${id}.mp4`))) throw Error(`Missing source video: ${id}`);
  if (existsSync(output)) throw Error('Output directory must be new; inspect any existing job before starting another');
  if (await digest(model, 'sha1') !== expectedModelSha1) throw Error('Model differs from the recorded upstream large-v3-turbo-q5_0 SHA-1');
  const whisperVersion = capture('whisper-cli', ['--version']);
  const ffmpegVersion = capture('ffmpeg', ['-version']).split('\n')[0];
  mkdirSync(output);
  const manifest = {
    schema: 'koyuki.lecture-local-asr.v1', startedAt: new Date().toISOString(), status: 'running', phase: 'prepare',
    collectorSha256: await digest(fileURLToPath(import.meta.url)), node: process.version, whisperVersion, ffmpegVersion,
    model: { file: basename(model), sha1: expectedModelSha1, sha256: await digest(model),
      reference: 'https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md',
      download: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' },
    language: 'ja', captionsSuppliedToAsr: false, initialPromptSupplied: false, audioUploaded: false,
    audioDirectlyReviewed: false, allFramesReviewed: false,
    scope: 'Separate local ASR path from saved MP4 audio. Recognition is not verified speech, direct listening, frame review or implementation completeness. Training-data overlap is unknown.',
    videos: [],
  };
  const save = () => writeFileSync(join(output, 'manifest.json'), JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  save();
  try {
    for (const videoId of videos) {
      manifest.videoId = videoId; manifest.phase = 'decode'; save();
      const path = join(source, `${videoId}.mp4`), sourceSha256 = await digest(path);
      const wav = join(output, `${videoId}.wav`), stem = join(output, videoId);
      logged('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-n', wav], join(output, `${videoId}-decode.log`));
      const audio = JSON.parse(capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', wav]));
      manifest.phase = 'transcribe'; save();
      const started = performance.now();
      logged('whisper-cli', ['-m', model, '-l', 'ja', '-oj', '-of', stem, '-f', wav], join(output, `${videoId}-asr.log`));
      const transcriptionMs = performance.now() - started;
      const transcript = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
      if (!Array.isArray(transcript.transcription) || !transcript.transcription.length) throw Error(`No recognized segments: ${videoId}`);
      if (await digest(path) !== sourceSha256) throw Error(`Source changed during ASR: ${videoId}`);
      manifest.videos.push({ videoId, sourceFile: `${videoId}.mp4`, sourceSha256, audioFile: basename(wav), audioSha256: await digest(wav),
        audioSeconds: Number(audio.format.duration), streams: audio.streams, transcriptionMs,
        transcriptFile: `${videoId}.json`, transcriptSha256: await digest(`${stem}.json`), segments: transcript.transcription.length,
        lastRecognizedOffsetMs: transcript.transcription.at(-1).offsets?.to ?? null });
      save();
    }
    if (await digest(model) !== manifest.model.sha256) throw Error('Model changed during ASR');
    manifest.status = 'completed'; manifest.phase = 'done'; delete manifest.videoId; save();
    console.log(JSON.stringify(manifest, null, 2));
  } catch (cause) {
    manifest.status = 'failed'; save(); throw cause;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
