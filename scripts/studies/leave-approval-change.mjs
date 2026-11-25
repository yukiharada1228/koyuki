import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Apply a real policy change to the temporary independent consumer, retaining actual diffs. */
export function studyApprovalChange(consumer, root, run) {
  copyFileSync(join(root, 'scripts/fixtures/leave-approval-baselines.ts'), join(consumer, 'approval-baselines.ts'));
  console.log(run('npm', ['run', 'check'], consumer));
  // Commit a formerly valid three-day approval using the unchanged old declaration.
  console.log(run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {SqliteLeave} from './repository.js';
    import {leaveCommands} from './application-named.js';
    const r=new SqliteLeave('historical.sqlite');
    try {
      if(!r.seed('owner',5).ok) throw new Error('SeedFailed');
      const input={employee:'owner',leaveId:'one',expectedVersion:1,days:3};
      if(!(await leaveCommands(r,{id:'owner',role:'employee',active:true}).submit.run({requestId:'before-policy-submit',input})).ok) throw new Error('SubmitFailed');
      if(!(await leaveCommands(r,{id:'boss',role:'manager',active:true}).approve.run({requestId:'before-policy-approve',input:{...input,expectedVersion:2}})).ok) throw new Error('ApproveFailed');
    } finally {r.close();}
  `], consumer));
  const untouched = new Map(['repository.ts', 'server.ts'].map(file => [file, readFileSync(join(consumer, file), 'utf8')]));
  const snapshots = new Map();
  const read = file => readFileSync(join(consumer, file), 'utf8');
  const write = (file, source) => {
    if (!snapshots.has(file)) snapshots.set(file, read(file));
    writeFileSync(join(consumer, file), source);
  };
  const replace = (file, before, after) => {
    const source = read(file);
    assert.equal(source.split(before).length, 2, `Expected one source location in ${file}: ${before}`);
    write(file, source.replace(before, after));
  };
  // Keep ordinary functions and repository/input types; only approval's proof obligation changes.
  replace('domain.ts', "{ kind: 'InsufficientDays' };", "{ kind: 'InsufficientDays' } | { kind: 'ApprovalLimitExceeded' };");
  replace('domain.ts', 'approve(command: Approval)', 'approve(command: LimitedApproval)');
  write('domain.ts', read('domain.ts') + `
// New policy: only pending requests of at most two days may be approved.
declare const approvalLimit: unique symbol;
export type LimitedApproval = Approval & { readonly [approvalLimit]: true };
export function requireApprovalLimit(command: Approval): Result<LimitedApproval, { kind: 'ApprovalLimitExceeded' }> {
  return command.pending.days > 2 ? err({ kind: 'ApprovalLimitExceeded' }) : ok(command as LimitedApproval);
}
`);
  const broken = spawnSync('npm', ['exec', '--', 'tsc', '--pretty', 'false'], { cwd: consumer, encoding: 'utf8' });
  const diagnostics = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
  assert.notEqual(broken.status, 0, 'Changing the required proof must invalidate old connections');
  for (const file of ['application.ts', 'application-named.ts', 'approval-baselines.ts', 'http.ts', 'graphql.ts']) {
    assert(diagnostics.includes(`${file}(`), `Expected a migration diagnostic in ${file}:\n${diagnostics}`);
  }
  assert(!/TS230[57]|TS7006/.test(diagnostics), diagnostics);
  // Record that both plain TS implementations are independently rejected, not just the file.
  const baselineLines = read('approval-baselines.ts').split('\n');
  for (const fragment of ['return approve(validation.value);', 'return chain(validateApproval(input), approve);']) {
    const line = baselineLines.findIndex(text => text.includes(fragment)) + 1;
    assert(diagnostics.includes(`approval-baselines.ts(${line},`), diagnostics);
  }
  console.log('Policy mutation rejected all four old decision connections and unmapped HTTP/GraphQL errors.');
  for (const file of ['application.ts', 'application-named.ts', 'approval-baselines.ts']) {
    replace(file, 'validateApproval, approve,', 'validateApproval, requireApprovalLimit, approve,');
  }
  replace('application.ts', 'approve: [validateApproval, approve]', 'approve: [validateApproval, requireApprovalLimit, approve]');
  replace('application-named.ts', "export const approved = { validate: step('authorize-approval', validateApproval), require: [] as const, evolve: step('approve', approve) };",
    "export const approved = { validate: step('authorize-approval', validateApproval), require: [step('approval-limit', requireApprovalLimit)] as const, evolve: step('approve', approve) };");
  replace('approval-baselines.ts', '  return approve(validation.value);', '  const limited = requireApprovalLimit(validation.value);\n  if (!limited.ok) return limited;\n  return approve(limited.value);');
  replace('approval-baselines.ts', 'return chain(validateApproval(input), approve);', 'return chain(chain(validateApproval(input), requireApprovalLimit), approve);');
  replace('http.ts', 'Conflict: 409, IdempotencyConflict:', 'ApprovalLimitExceeded: 422, Conflict: 409, IdempotencyConflict:');
  replace('graphql.ts', "  Conflict: 'Conflict',", "  ApprovalLimitExceeded: 'ApprovalLimitExceeded',\n  Conflict: 'Conflict',");
  copyFileSync(join(root, 'scripts/fixtures/leave-approval-change.test.ts'), join(consumer, 'approval-change.test.ts'));
  console.log(run('npm', ['run', 'check'], consumer));
  console.log(run('npm', ['exec', '--', 'tsx', '--test', 'approval-change.test.ts'], consumer));
  const changes = [...snapshots].map(([file, before]) => {
    const after = read(file);
    const beforePath = join(consumer, `${file}.before`);
    writeFileSync(beforePath, before);
    const compared = spawnSync('git', ['diff', '--no-index', '--no-color', '--', beforePath, join(consumer, file)], { cwd: consumer, encoding: 'utf8' });
    assert.equal(compared.status, 1, compared.stderr || 'Each recorded migration file must have a real diff');
    return { file, beforeSha256: createHash('sha256').update(before).digest('hex'), afterSha256: createHash('sha256').update(after).digest('hex'), diff: compared.stdout };
  });
  assert.equal(changes.length, 6);
  for (const [file, before] of untouched) assert.equal(read(file), before, `${file} unexpectedly changed`);
  console.log(JSON.stringify({ scope: 'Approval rule migration in the temporary leave consumer; ordinary TS comparison covers pure decisions only',
    changedFiles: changes, unchanged: ['repository.ts', 'server.ts'],
    limitations: ['No productivity or learning-time measurement', 'No plain-TS replay/runtime equivalence claim', 'Historical receipts remain historical successes'],
  }, null, 2));
}
