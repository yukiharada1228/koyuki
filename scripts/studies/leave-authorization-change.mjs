import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
/** A second migration, after the approval-limit study, confined to the installed consumer. */
export function studyAuthorizationChange(consumer, root, run) {
  const read = file => readFileSync(join(consumer, file), 'utf8');
  const untouchedFiles = ['application.ts', 'application-named.ts', 'approval-baselines.ts', 'repository.ts', 'server.ts'];
  const untouched = new Map(untouchedFiles.map(file => [file, read(file)]));
  const before = new Map(['domain.ts', 'http.ts', 'graphql.ts'].map(file => [file, read(file)]));
  const replace = (file, old, next) => {
    const source = read(file); assert.equal(source.split(old).length, 2, `Expected one location in ${file}: ${old}`);
    writeFileSync(join(consumer, file), source.replace(old, next));
  };
  replace('domain.ts', 'readonly active: boolean }', 'readonly active: boolean; readonly approvalEnabled?: boolean }');
  replace('domain.ts', "{ kind: 'ApprovalLimitExceeded' };", "{ kind: 'ApprovalLimitExceeded' } | { kind: 'ApprovalDisabled' };");
  replace('domain.ts', "  const pending = command.account.leaves.find(l => l.id === command.input.leaveId);\n  if (!pending || pending.kind !== 'pending') return err({ kind: 'InvalidState' });\n  return ok({ ...command, pending } as Approval);",
    "  if (command.actor.approvalEnabled === false) return err({ kind: 'ApprovalDisabled' });\n  const pending = command.account.leaves.find(l => l.id === command.input.leaveId);\n  if (!pending || pending.kind !== 'pending') return err({ kind: 'InvalidState' });\n  return ok({ ...command, pending } as Approval);");
  const broken = spawnSync('npm', ['exec', '--', 'tsc', '--pretty', 'false'], { cwd: consumer, encoding: 'utf8' });
  const diagnostics = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
  assert(!broken.error && Number.isInteger(broken.status) && broken.status > 0, 'New error must invalidate the incomplete HTTP and GraphQL maps');
  const files = [...diagnostics.matchAll(/^([^\n]+\.tsx?)\(/gm)].map(match => match[1]);
  assert(files.length > 0 && files.every(file => ['http.ts', 'graphql.ts'].includes(file)) && files.includes('http.ts') && files.includes('graphql.ts'), diagnostics);
  assert(diagnostics.includes('ApprovalDisabled') && !/TS230[57]|TS7006/.test(diagnostics), diagnostics);
  console.log('Authorization error reached the exhaustive HTTP and GraphQL maps; existing decision connections need no edits, while both transport maps require the new code.');
  replace('http.ts', 'ApprovalLimitExceeded: 422, Conflict: 409,', 'ApprovalDisabled: 403, ApprovalLimitExceeded: 422, Conflict: 409,');
  replace('graphql.ts', "  Conflict: 'Conflict',", "  ApprovalDisabled: 'ApprovalDisabled',\n  Conflict: 'Conflict',");
  copyFileSync(join(root, 'scripts/fixtures/leave-authorization-change.test.ts'), join(consumer, 'authorization-change.test.ts'));
  console.log(run('npm', ['run', 'check'], consumer));
  console.log(run('npm', ['exec', '--', 'tsx', '--test', 'authorization-change.test.ts'], consumer));
  const changes = [...before].map(([file, source]) => {
    const path = join(consumer, `${file}.authorization-before`); writeFileSync(path, source);
    const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', path, join(consumer, file)], { cwd: consumer, encoding: 'utf8' });
    assert.equal(diff.status, 1, `Expected a source change in ${file}`);
    return { file, beforeSha256: createHash('sha256').update(source).digest('hex'), afterSha256: createHash('sha256').update(read(file)).digest('hex'), diff: diff.stdout };
  });
  for (const [file, source] of untouched) assert.equal(read(file), source, `${file} must remain unchanged`);
  console.log(JSON.stringify({ scope: 'Authorization capability migration in the temporary installed consumer, after the approval-limit migration; no production source mutation.',
    changes, unchanged: untouchedFiles,
    limits: ['Pure-decision parity only for ordinary TS baselines', 'GraphQL publishes an enum, but client generation and exhaustive handling remain external', 'Historical receipts are readable after capability disablement by explicit policy', 'No live-directory or mid-flight capability revalidation'],
  }, null, 2));
}
