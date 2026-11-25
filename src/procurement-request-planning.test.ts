import test from 'node:test';
import assert from 'node:assert/strict';
import { err } from './framework/index.js';
import { procurement } from './experiments/procurement/application.js';
import { MemoryProcurement, type ProcurementRepository } from './experiments/procurement/repository.js';
import { SqliteProcurement } from './experiments/procurement/sqlite.js';
import { createRequest, submitRequest, approveRequest, placeOrder, checkBuyerRequest, checkApproverRequest,
  submitCheckedRequest, approveCheckedRequest, placeCheckedOrder, type Actor, type Request, type Policy, type RuleError } from './experiments/procurement/domain.js';
const buyer: Actor = { id: 'buyer', role: 'buyer', groupId: 'g1', active: true };
const boss: Actor = { ...buyer, id: 'boss', role: 'approver' };
const final: Actor = { ...boss, id: 'final' };
const policy: Policy = { requestLimitCents: 1000, approverIds: ['boss', 'final'] };
const lines = [{ sku: 'a', quantity: 1, unitCents: 100 }];
function draft() {
  const result = createRequest({ input: { id: 'rq', lines }, actor: buyer }); assert(result.ok);
  return result.value.result;
}
function context(current: Request = draft(), actor = buyer) {
  return { current, actor, policy, alreadyOrdered: false,
    input: { id: 'rq', expectedVersion: current.version, approverId: 'boss', orderId: 'po', supplier: ' supplier ' } };
}

test('submission, approval and placement retain independently specified refusal priority', () => {
  const submitted = submitRequest(context()); assert(submitted.ok);
  const approved = approveRequest(context(submitted.value.result, boss)); assert(approved.ok);
  type Context = ReturnType<typeof context>;
  const mutations: readonly [(value: Context) => Context, RuleError['kind']][] = [
    [value => ({ ...value, actor: { ...value.actor, active: false }, input: { ...value.input, id: 'wrong', expectedVersion: 0 } }), 'Denied'],
    [value => ({ ...value, input: { ...value.input, id: 'wrong', expectedVersion: 0 } }), 'TargetMismatch'],
    [value => ({ ...value, input: { ...value.input, expectedVersion: 0 } }), 'InvalidInput'],
    [value => ({ ...value, input: { ...value.input, expectedVersion: 99 } }), 'Conflict'],
  ];
  for (const [run, value] of [[submitRequest, context()], [approveRequest, context(submitted.value.result, boss)], [placeOrder, context(approved.value.result)]] as const) {
    for (const [mutate, kind] of mutations) {
      const invalid = mutate(value), before = structuredClone(invalid);
      assert.deepEqual(run(invalid), err({ kind })); assert.deepEqual(invalid, before);
    }
  }
  const wrongStates = [
    [submitRequest, { ...context(submitted.value.result), input: { ...context().input, expectedVersion: 2, approverId: '' } }],
    [approveRequest, context(draft(), boss)],
    [placeOrder, { ...context(), alreadyOrdered: true, input: { ...context().input, supplier: '' } }],
  ] as const;
  for (const [run, value] of wrongStates) {
    assert.deepEqual(run({ ...value, input: { ...value.input, expectedVersion: 0 } }), err({ kind: 'InvalidInput' }));
    assert.deepEqual(run({ ...value, input: { ...value.input, expectedVersion: 99 } }), err({ kind: 'Conflict' }));
    assert.deepEqual(run(value), err({ kind: 'WrongState' }));
  }
  const other = { ...boss, id: 'other' };
  assert.deepEqual(approveRequest(context(submitted.value.result, other)), err({ kind: 'Denied' }));
  assert.deepEqual(approveRequest({ ...context(submitted.value.result, other), input: { ...context().input, expectedVersion: 0 } }), err({ kind: 'InvalidInput' }));
});

test('checked operations retain context identity and explicit dual-approval and placement plans', () => {
  const original = context(), before = structuredClone(original);
  const singleCheck = checkBuyerRequest(original); assert(singleCheck.ok); assert.strictEqual(singleCheck.value, original);
  const expectedSingle = { ...original.current, state: 'submitted', approverId: 'boss', version: 2 };
  assert.deepEqual(submitCheckedRequest(singleCheck.value), { ok: true, value: { result: expectedSingle, writes: [expectedSingle], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 1 }] } });
  const dual = { ...original, policy: { ...policy, secondApproval: { aboveCents: 50, approverId: 'final' } } };
  const checked = checkBuyerRequest(dual); assert(checked.ok); assert.strictEqual(checked.value, dual);
  const first = submitCheckedRequest(checked.value); assert(first.ok);
  const expectedFirst = { ...original.current, state: 'first-review', approverId: 'boss', finalApproverId: 'final', version: 2 };
  assert.deepEqual(first.value, { result: expectedFirst, writes: [expectedFirst], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 1 }] });
  const firstContext = context(first.value.result, boss), firstCheck = checkApproverRequest(firstContext); assert(firstCheck.ok); assert.strictEqual(firstCheck.value, firstContext);
  const second = approveCheckedRequest(firstCheck.value); assert(second.ok);
  const expectedSecond = { ...original.current, state: 'final-review', approverId: 'final', firstApprovedBy: 'boss', version: 3 };
  assert.deepEqual(second.value, { result: expectedSecond, writes: [expectedSecond], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 2 }] });
  const secondCheck = checkApproverRequest(context(second.value.result, final)); assert(secondCheck.ok);
  const approved = approveCheckedRequest(secondCheck.value); assert(approved.ok);
  const expectedApproved = { ...original.current, state: 'approved', approval: 'dual', approverId: 'final', firstApprovedBy: 'boss', approvedBy: 'final', version: 4 };
  assert.deepEqual(approved.value, { result: expectedApproved, writes: [expectedApproved], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 3 }] });
  const placeContext = context(approved.value.result), placeCheck = checkBuyerRequest(placeContext); assert(placeCheck.ok); assert.strictEqual(placeCheck.value, placeContext);
  const order = { kind: 'order', state: 'placed', id: 'po', groupId: 'g1', version: 1, requestId: 'rq', ownerId: 'buyer', supplier: 'supplier', lines: original.current.lines, totalCents: 100 };
  assert.deepEqual(placeCheckedOrder(placeCheck.value), { ok: true, value: { result: order, writes: [order], checks: [{ kind: 'request', id: 'rq', groupId: 'g1', version: 4 }, { kind: 'order', id: 'po', groupId: 'g1', version: null }] } });
  assert.deepEqual(original, before);
});

for (const backend of ['memory', 'sqlite']) test(`request planning stops at check, decision and save boundaries: ${backend}`, async () => {
  const repository = backend === 'memory' ? new MemoryProcurement() : new SqliteProcurement(':memory:', 'g1');
  let commits = 0, refused = false;
  const tracked: ProcurementRepository = { read: repository.read.bind(repository), related: repository.related.bind(repository), commit: (change, actor) => {
    commits++; return refused ? Promise.resolve(err({ kind: 'Conflict' })) : repository.commit(change, actor);
  } };
  const owner = procurement(tracked, buyer, policy), approver = procurement(tracked, boss, policy);
  const snapshot = () => (['request', 'order', 'receipt', 'invoice', 'payment', 'stock'] as const).map(kind => repository.list(kind, buyer));
  try {
    assert((await owner.requests.create({ id: 'rq', lines })).ok);
    const initial = snapshot();
    const version = await owner.requests.submit.runDetailed({ id: 'rq', expectedVersion: 0, approverId: '' });
    assert.deepEqual(version.result, err({ kind: 'InvalidInput' })); assert.deepEqual(version.trace.map(row => row.status), ['ok', 'error']);
    const invalid = await owner.requests.submit.runDetailed({ id: 'rq', expectedVersion: 1, approverId: '' });
    assert.deepEqual(invalid.result, err({ kind: 'InvalidInput' })); assert.deepEqual(invalid.trace.map(row => row.status), ['ok', 'ok', 'error']);
    assert.equal(invalid.plan, null); assert.equal(commits, 1); assert.deepEqual(snapshot(), initial);
    const submitted = await owner.requests.submit.runDetailed({ id: 'rq', expectedVersion: 1, approverId: 'boss' }); assert(submitted.result.ok);
    assert.deepEqual(submitted.trace.map(row => row.status), ['ok', 'ok', 'ok', 'ok']);
    const pending = snapshot();
    const denied = await procurement(tracked, { ...boss, id: 'other' }, policy).requests.approve.runDetailed({ id: 'rq', expectedVersion: 2 });
    assert.deepEqual(denied.result, err({ kind: 'Denied' })); assert.deepEqual(denied.trace.map(row => row.status), ['ok', 'error']); assert.equal(denied.plan, null);
    assert.equal(commits, 2); assert.deepEqual(snapshot(), pending);
    assert((await approver.requests.approve({ id: 'rq', expectedVersion: 2 })).ok);
    const beforeOrder = snapshot();
    const stale = await owner.orders.place.runDetailed({ id: 'rq', expectedVersion: 2, orderId: 'po', supplier: '' });
    assert.deepEqual(stale.result, err({ kind: 'Conflict' })); assert.deepEqual(stale.trace.map(row => row.status), ['ok', 'error']);
    const supplier = await owner.orders.place.runDetailed({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: '' });
    assert.deepEqual(supplier.result, err({ kind: 'InvalidInput' })); assert.deepEqual(supplier.trace.map(row => row.status), ['ok', 'ok', 'error']); assert.equal(supplier.plan, null);
    assert.equal(commits, 3); assert.deepEqual(snapshot(), beforeOrder);
    refused = true;
    const save = await owner.orders.place.runDetailed({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' });
    assert.deepEqual(save.result, err({ kind: 'Conflict' })); assert.deepEqual(save.trace.map(row => row.status), ['ok', 'ok', 'ok', 'error']);
    assert(save.plan); assert.deepEqual(snapshot(), beforeOrder); assert.equal(commits, 4);
    refused = false;
    assert((await owner.orders.place({ id: 'rq', expectedVersion: 3, orderId: 'po', supplier: 'supplier' })).ok);
    assert.equal(commits, 5); assert.equal(repository.list('request', buyer)[0]?.version, 3); assert.equal(repository.list('order', buyer)[0]?.version, 1);
  } finally { if (repository instanceof SqliteProcurement) repository.close(); }
});

function typeContracts() {
  const raw = context();
  // @ts-expect-error raw input has no buyer verification proof
  submitCheckedRequest(raw);
  // @ts-expect-error raw input has no approver verification proof
  approveCheckedRequest(raw);
  // @ts-expect-error raw input has no buyer verification proof
  placeCheckedOrder(raw);
  const buyerCheck = checkBuyerRequest(raw), approverCheck = checkApproverRequest(context(draft(), boss));
  if (buyerCheck.ok && approverCheck.ok) {
    // @ts-expect-error a buyer proof cannot authorize approval
    approveCheckedRequest(buyerCheck.value);
    // @ts-expect-error an approver proof cannot authorize submission
    submitCheckedRequest(approverCheck.value);
    // @ts-expect-error an approver proof cannot authorize placement
    placeCheckedOrder(approverCheck.value);
  }
}
void typeContracts;
