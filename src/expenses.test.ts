import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, transition } from './framework/index.js';
import { draftExpense, validateSubmission, submit, submitRouted, validateApproval, approve, validateRejection, reject, type Actor, type Submission, type Draft, type PendingFinance, type Change, type Loaded, type Rejected } from './expenses/domain.js';
import { MemoryExpenses } from './expenses/repository.js';
import { expenseApplication, expenseModel, submitted, approved, rejected } from './expenses/application.js';
const employee: Actor = { id: 'owner', role: 'employee', active: true };
const manager: Actor = { id: 'boss', role: 'manager', active: true };
const finance: Actor = { id: 'accountant', role: 'finance', active: true };
function draft(amount = 200000, receipt = true): Draft {
  const result = draftExpense({ id: 'e1', owner: 'owner', amount, receipt }); assert(result.ok); return result.value;
}
async function action(repository: MemoryExpenses, actor: Actor, type: 'submit' | 'approve' | 'reject', reason?: string) {
  const model = expenseModel(repository, actor), row = repository.read('e1')!;
  if (type === 'submit') return model.change.on(submitted).run({ id: row.id, expectedVersion: row.version });
  if (type === 'approve') return model.change.on(approved).run({ id: row.id, expectedVersion: row.version });
  return model.rejection.on(rejected).run({ id: row.id, expectedVersion: row.version, reason: reason ?? '' });
}
for (const [amount, route] of [[3000, 'approved'], [3001, 'manager'], [100000, 'manager'], [100001, 'manager']] as const) {
  test(`submission amount ${amount} chooses ${route} using existing business rules`, async () => {
    const repository = new MemoryExpenses([draft(amount)]), result = await action(repository, employee, 'submit');
    assert(result.ok); assert.equal(result.value.kind, route); assert.equal(result.value.version, 2);
    assert.deepEqual(repository.calls, ['load', 'save']);
  });
}
test('high-value expense passes manager and finance states with retained approval evidence', async () => {
  const repository = new MemoryExpenses([draft()]);
  assert((await action(repository, employee, 'submit')).ok);
  const middle = await action(repository, manager, 'approve'); assert(middle.ok && middle.value.kind === 'finance'); assert.equal(middle.value.manager, 'boss');
  const final = await action(repository, finance, 'approve'); assert(final.ok && final.value.kind === 'approved');
  assert.deepEqual(final.value.approval, { kind: 'finance', manager: 'boss', finance: 'accountant' }); assert.equal(final.value.version, 4);
  const duplicate = await action(repository, finance, 'approve'); assert(!duplicate.ok && duplicate.error.kind === 'InvalidState');
});
test('ordinary expense completes after manager approval, no finance approval required', async () => {
  const repository = new MemoryExpenses([draft(5000)]);
  await action(repository, employee, 'submit');
  const result = await action(repository, manager, 'approve'); assert(result.ok && result.value.kind === 'approved');
  assert.deepEqual(result.value.approval, { kind: 'manager', manager: 'boss' });
});
test('missing receipt stops submission before save but small automatic route still works', async () => {
  const repository = new MemoryExpenses([draft(5000, false)]);
  const result = await action(repository, employee, 'submit'); assert(!result.ok && result.error.kind === 'ReceiptRequired');
  assert.deepEqual(repository.calls, ['load']); assert.equal(repository.read('e1')?.kind, 'draft');
  const small = new MemoryExpenses([draft(100, false)]); assert((await action(small, employee, 'submit')).ok);
});
test('wrong actor, inactive actor, and self approval cannot advance state', async () => {
  const repository = new MemoryExpenses([draft()]);
  const wrongOwner = await action(repository, manager, 'submit'); assert(!wrongOwner.ok && wrongOwner.error.kind === 'Forbidden');
  await action(repository, employee, 'submit');
  for (const actor of [finance, { ...manager, active: false }]) {
    const result = await action(repository, actor, 'approve'); assert(!result.ok && result.error.kind === 'Forbidden');
  }
  const self = await action(repository, { ...employee, role: 'manager' }, 'approve'); assert(!self.ok && self.error.kind === 'SelfApproval');
  assert.equal(repository.read('e1')?.kind, 'manager'); assert.equal(repository.calls.filter(c => c === 'save').length, 1);
});
test('rejection needs a reason, keeps actor evidence, and terminal state rejects later approvals', async () => {
  const repository = new MemoryExpenses([draft()]); await action(repository, employee, 'submit');
  const empty = await action(repository, manager, 'reject', ' '); assert(!empty.ok && empty.error.kind === 'ReasonRequired');
  const rejected = await action(repository, manager, 'reject', '  要確認  '); assert(rejected.ok && rejected.value.kind === 'rejected');
  assert.equal(rejected.value.reason, '要確認'); assert.equal(rejected.value.by, 'boss');
  const later = await action(repository, manager, 'approve'); assert(!later.ok && later.error.kind === 'InvalidState');
});
test('stale prepared decisions cannot both commit', async () => {
  const repository = new MemoryExpenses([draft()]); await action(repository, employee, 'submit');
  const command = await repository.load({ id: 'e1', expectedVersion: 2 }, manager); assert(command.ok);
  const yes = transition(approved).run(command.value); assert(yes.ok);
  const loadedNo = await repository.loadReject({ id: 'e1', expectedVersion: 2, reason: 'reject' }, manager); assert(loadedNo.ok);
  const no = transition(rejected).run(loadedNo.value); assert(no.ok);
  const results = await Promise.all([repository.save(yes.value), repository.save(no.value)]);
  assert.equal(results.filter(r => r.ok).length, 1);
});
test('standard application supplies lifecycle without handwritten completion events', async () => {
  const repository = new MemoryExpenses([draft()]);
  const first = await expenseApplication(repository, employee, repository.list()).start();
  const phases: string[] = []; first.subscribe(s => phases.push(s.state.kind));
  await first.dispatch({ type: 'submit', input: { id: 'e1', expectedVersion: 1 } });
  assert.deepEqual(phases, ['ready', 'running', 'ready']); assert.equal(first.snapshot().view.expenses[0]?.kind, 'manager');
  const boss = await expenseApplication(repository, manager, repository.list()).start();
  await boss.dispatch({ type: 'approve', input: { id: 'e1', expectedVersion: 2 } }); assert.equal(boss.snapshot().view.expenses[0]?.kind, 'finance');
  const accounting = await expenseApplication(repository, finance, repository.list()).start();
  await accounting.dispatch({ type: 'approve', input: { id: 'e1', expectedVersion: 3 } }); assert.equal(accounting.snapshot().view.expenses[0]?.kind, 'approved');
});
test('application failure preserves business state, typed reason, and standard dismiss behavior', async () => {
  const repository = new MemoryExpenses([draft()]);
  const session = await expenseApplication(repository, manager, repository.list()).start();
  await session.dispatch({ type: 'submit', input: { id: 'e1', expectedVersion: 1 } });
  const state = session.snapshot().state; assert(state.kind === 'failed'); assert.equal(state.error.kind, 'Forbidden');
  assert.equal(state.data[0]?.kind, 'draft'); await session.dispatch({ type: 'dismiss' }); assert.equal(session.snapshot().state.kind, 'ready');
});
// Direct Result composition baseline deliberately avoids target/transition/application helpers.
async function plain(repository: MemoryExpenses, actor: Actor, kind: 'submit' | 'approve' | 'reject') {
  const row = repository.read('e1')!, input = { id: 'e1', expectedVersion: row.version, reason: 'policy' };
  if (kind === 'reject') {
    const loaded = await repository.loadReject(input, actor); if (!loaded.ok) return loaded;
    const valid = validateRejection(loaded.value); if (!valid.ok) return valid;
    const change = reject(valid.value); if (!change.ok) return change;
    return repository.save(change.value);
  }
  const loaded = await repository.load(input, actor); if (!loaded.ok) return loaded;
  if (kind === 'submit') {
    const valid = validateSubmission(loaded.value); if (!valid.ok) return valid;
    const change = submit(valid.value); if (!change.ok) return change;
    return repository.save(change.value);
  }
  const valid = validateApproval(loaded.value); if (!valid.ok) return valid;
  const change = approve(valid.value); if (!change.ok) return change;
  return repository.save(change.value);
}
test('plain and framework agree on policy branches, permissions, failures and final stored state', async () => {
  for (const amount of [100, 5000, 200000]) for (const receipt of [true, false]) {
    const a = new MemoryExpenses([draft(amount, receipt)]), b = new MemoryExpenses([draft(amount, receipt)]);
    for (const [actor, kind] of [[employee, 'submit'], [employee, 'approve'], [manager, 'approve'], [finance, 'approve'], [finance, 'reject']] as const) {
      assert.deepEqual(await action(a, actor, kind, 'policy'), await plain(b, actor, kind));
      assert.deepEqual(a.list(), b.list()); assert.deepEqual(a.calls, b.calls);
    }
  }
});
function invalidDefinitions(command: Loaded, denied: Rejected, model: ReturnType<typeof expenseModel>) {
  // @ts-expect-error finance state must retain the preceding manager approval
  const missingEvidence: PendingFinance = { id: 'e', owner: 'o', amount: 200000, receipt: true, version: 3, kind: 'finance' };
  // @ts-expect-error unvalidated command cannot go directly to approval
  approve(command);
  // @ts-expect-error an arbitrary terminal state cannot be minted as a save decision
  const forged: Change = { expectedVersion: 1, next: denied };
  // @ts-expect-error approve validator cannot feed submission transition
  model.change.on({ ...submitted, validate: approved.validate });
  void [missingEvidence, forged];
}
void invalidDefinitions;

function invalidRouting(submission: Submission, decision: import('./examples/expense.js').ExpenseDecision) {
  // @ts-expect-error a structural routing object is not evidence that routing validation ran
  submitRouted({ input: submission, value: decision });
}
void invalidRouting;
