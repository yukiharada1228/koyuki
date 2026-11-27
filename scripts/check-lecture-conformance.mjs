import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--report'), 'Use [--report output.json]');
const followups = {
  'iz-22': ['src/authoring-declaration.test.tsx', 'docs/authoring-names-and-reuse-review.md', 'docs/authoring-specification-change.md'],
  'iz-24': ['src/authoring-declaration.test.tsx', 'src/business-request-prefix.test.ts', 'docs/inline-inference-compiler-boundary.md'],
  'iz-31': ['src/authoring-registration.test.tsx', 'src/registration-lease.test.ts', 'docs/registration-events.md'],
  'iz-36': ['src/authoring-leave-domain.test.ts', 'docs/lecture-source-requirements-review.md'],
  'qbf-12': ['src/collect-fields.test.ts'],
  'qbf-19': ['src/authoring-declaration.test.tsx', 'src/business-request-prefix.test.ts'],
  'w0o-13': ['src/authoring-capture.test.tsx', 'src/workflow-observation.test.ts'],
  'w0o-17': ['docs/lecture-frame-window-survey.md', 'docs/lecture-decks.json'],
  'w0o-23': ['docs/lecture-frame-window-survey.md', 'docs/lecture-uncertain-speech-decisions.md'],
};
const sections = [];
for (const video of ['izV1h6o3hgQ', 'qBf910_YiqA', 'w0oLNoGsGLc']) {
  const audit = JSON.parse(readFileSync(join(root, `docs/lecture-audits/${video}.json`), 'utf8'));
  for (const section of audit.sections) {
    const evidence = [...new Set([...section.evidence, ...(followups[section.id] ?? [])])];
    for (const file of evidence) assert(existsSync(join(root, file)), `Missing evidence: ${section.id} ${file}`);
    sections.push({ video, ...section, evidence });
  }
}
assert.equal(sections.length, 84);
assert.equal(new Set(sections.map(section => section.id)).size, 84);
function run(command, parameters) {
  const result = spawnSync(command, parameters, { cwd: root, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
  assert(!result.error && result.status === 0, (result.stdout ?? '') + (result.stderr ?? '') || String(result.error));
  return result.stdout.trim();
}
const head = run('git', ['rev-parse', 'HEAD']);
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
const gates = [];
for (const script of ['check', 'test:lecture-records', 'test', 'test:authoring:package', 'test:authoring:change']) {
  const output = run('npm', ['run', script]);
  gates.push({ command: `npm run ${script}`, passed: true, outputSha256: createHash('sha256').update(output).digest('hex'), outputTail: output.split('\n').slice(-20).join('\n') });
  console.log(`Passed: npm run ${script}`);
}
const counts = Object.fromEntries([...new Set(sections.map(section => section.status))].map(status => [status, sections.filter(section => section.status === status).length]));
const report = {
  implementationBaseCommit: head,
  trackedWorkingTreeAtStart: dirty,
  scope: 'Current implementation regression evidence mapped to all saved lecture sections. Passing gates do not verify original audio, human usability or every semantic claim.',
  completeLectureConformanceProven: false,
  blockers: ['Ten original-audio intervals remain unreviewed; no direct-audio claim is made.', 'Nine partial source assessments and general inference/experience/operational limits remain; test success does not remove them.'],
  counts, sections, gates,
};
if (args[1]) writeFileSync(resolve(root, args[1]), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ counts, completeLectureConformanceProven: report.completeLectureConformanceProven }));
