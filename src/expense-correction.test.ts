import test from 'node:test';
import assert from 'node:assert/strict';
import { draftExpense, validateEdit, edit, type Actor } from './expenses/domain.js';
import { expenseApplication } from './expenses/application.js';
import { MemoryExpenses } from './expenses/repository.js';
import { type Result } from './framework/index.js';
function value<T, E>(result: Result<T, E>): T { assert(result.ok, JSON.stringify(result)); return result.value; }
const owner: Actor = { id: 'owner', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };

test('same declarations run through ordinary application and memory adapter; edit is pure', async () => {
  const initial = value(draftExpense({ id: 'e1', owner: 'owner', amount: 5000, receipt: true }));
  const repository = new MemoryExpenses([initial]);
  const session = (actor: Actor) => expenseApplication(repository, actor, repository.list()).start();
  await (await session(owner)).dispatch({ type: 'submit', input: { id: 'e1', expectedVersion: 1 } });
  await (await session(manager)).dispatch({ type: 'return', input: { id: 'e1', expectedVersion: 2, reason: 'fix' } });
  const current = repository.read('e1')!;
  const input = { id: 'e1', expectedVersion: 3, amount: 2000, receipt: false };
  const loaded = { current, input, actor: owner };
  const before = structuredClone(loaded);
  const proof = value(validateEdit(loaded));
  const decision = value(edit(proof));
  assert.deepEqual(loaded, before);
  assert.equal(decision.next.kind, 'draft');
  assert.equal(decision.next.amount, 2000);
  await (await session(owner)).dispatch({ type: 'edit', input });
  await (await session(owner)).dispatch({ type: 'submit', input: { id: 'e1', expectedVersion: 4 } });
  assert.equal(repository.read('e1')!.kind, 'approved');
  if (false) {
    // @ts-expect-error an arbitrary loaded state cannot skip authorization/validation
    edit(loaded);
    // @ts-expect-error correction requires its new amount and receipt
    (await session(owner)).dispatch({ type: 'edit', input: { id: 'e1', expectedVersion: 3 } });
  }
});
