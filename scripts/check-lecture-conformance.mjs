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
const policy = JSON.parse(readFileSync(join(root, 'docs/lecture-caption-baseline.json'), 'utf8'));
assert.equal(policy.originalAudioVerified, false);
const overrides = new Map(policy.overrides.map(item => [item.id, item]));
assert.equal(overrides.size, policy.overrides.length, 'Duplicate caption reassessment');
const sections = [];
for (const video of ['izV1h6o3hgQ', 'qBf910_YiqA', 'w0oLNoGsGLc']) {
  const audit = JSON.parse(readFileSync(join(root, `docs/lecture-audits/${video}.json`), 'utf8'));
  for (const section of audit.sections) {
    const evidence = [...new Set([...section.evidence, ...(followups[section.id] ?? [])])];
    for (const file of evidence) assert(existsSync(join(root, file)), `Missing evidence: ${section.id} ${file}`);
    const revised = overrides.get(section.id);
    if (revised) {
      assert.equal(revised.historicalStatus, section.status);
      assert.equal(revised.captionSource.sha256, audit.source.sha256);
      assert.equal(revised.startSeconds, section.startSeconds);
      assert.equal(revised.endSeconds, section.endSeconds);
      assert(revised.requirement && revised.assessment);
      overrides.delete(section.id);
    }
    sections.push({ video, ...section, evidence, ...(revised ? { historicalStatus: section.status, status: revised.status, requirement: revised.requirement, assessment: revised.assessment, retainedLimitations: revised.retainedLimitations, remaining: [] } : {}) });
  }
}
assert.equal(overrides.size, 0, 'Unknown caption reassessment topic');
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
  scope: 'Assessment against the user-approved saved-caption baseline and corroborating slides. Tests support concrete examples; they do not prove original speech accuracy, general purity, human usability or production readiness.',
  sourcePolicy: policy.basis,
  originalAudioVerified: false,
  captionBaselineRequirementsAssessedAsImplemented: sections.every(section => ['supported', 'context', 'design-choice', 'experience'].includes(section.status)),
  productionReadinessProven: false,
  counts, sections, gates,
};
if (args[1]) writeFileSync(resolve(root, args[1]), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ counts, captionBaselineRequirementsAssessedAsImplemented: report.captionBaselineRequirementsAssessedAsImplemented }));
