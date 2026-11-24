import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLeave } from './repository.js';
import { leaveCommands as compact } from './application.js';
import { leaveCommands as explicit } from './application-legacy.js';
test('compact and explicit leave declarations preserve reports, replay and persisted state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-use-case-parity-'));
  const a = new SqliteLeave(join(dir, 'a.sqlite')), b = new SqliteLeave(join(dir, 'b.sqlite'));
  try {
    assert(a.seed('owner', 5).ok); assert(b.seed('owner', 5).ok);
    const actor = { id: 'owner', role: 'employee', active: true } as const;
    const old = explicit(a, actor), next = compact(b, actor);
    const call = { requestId: 'submit', input: { employee: 'owner', leaveId: 'leave', expectedVersion: 1, days: 3 } };
    assert.deepEqual(await next.submit.runDetailed(call), await old.submit.runDetailed(call));
    assert.deepEqual(await next.submit.runDetailed(call), await old.submit.runDetailed(call));
    const invalid = { requestId: 'over', input: { ...call.input, leaveId: 'next', expectedVersion: 2, days: 3 } };
    assert.deepEqual(await next.submit.runDetailed(invalid), await old.submit.runDetailed(invalid));
    const withdraw = { requestId: 'withdraw', input: { ...call.input, expectedVersion: 2 } };
    assert.deepEqual(await next.withdraw.run(withdraw), await old.withdraw.run(withdraw));
    assert.deepEqual(a.read('owner'), b.read('owner'));
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});
