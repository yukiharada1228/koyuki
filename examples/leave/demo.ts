import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLeave } from './repository.js';
import { leaveCommands, leaveApplication } from './application.js';
import { balance } from './domain.js';
const dir = mkdtempSync(join(tmpdir(), 'koyuki-leave-demo-'));
const repository = new SqliteLeave(join(dir, 'leave.sqlite'));
try {
  assert(repository.seed('owner', 5).ok);
  const owner = { id: 'owner', role: 'employee', active: true } as const;
  const employee = leaveCommands(repository, owner);
  const manager = leaveCommands(repository, { id: 'boss', role: 'manager', active: true });
  const input = (leaveId: string, expectedVersion: number) => ({ employee: 'owner', leaveId, expectedVersion });
  const request = { requestId: 'submit-1', input: { ...input('leave-1', 1), days: 3 } };
  const submitted = await employee.submit.run(request); assert(submitted.ok);
  console.log('申請（仮確保）:', JSON.stringify(balance(submitted.value.value)));
  const approved = await manager.approve.run({ requestId: 'approve-1', input: input('leave-1', 2) }); assert(approved.ok);
  console.log('承認（消化）:', JSON.stringify(balance(approved.value.value)));
  const next = await employee.submit.run({ requestId: 'submit-2', input: { ...input('leave-2', 3), days: 2 } }); assert(next.ok);
  const withdrawn = await employee.withdraw.run({ requestId: 'withdraw-2', input: input('leave-2', 4) }); assert(withdrawn.ok);
  console.log('別申請の取り下げ:', JSON.stringify(balance(withdrawn.value.value)));
  const session = await leaveApplication(repository, owner, withdrawn.value.value).start();
  await session.dispatch({ type: 'submit', input: request });
  assert.equal(session.snapshot().view.account.version, 5);
  assert.equal(session.snapshot().view.balance.available, 2);
  console.log('過去の申請を再送した後:', JSON.stringify(session.snapshot().view));
} finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
