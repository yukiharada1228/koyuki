import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, process, workflow, bindMutation, ok, err, type Result } from './framework/index.js';
import { validateShipping, inputWorkflow, serviceWorkflow, quoteWorkflow, type ShippingInput, type ShippingDecision } from './shipping/domain.js';
import { createShippingAction, shippingPlain, type ShippingPorts } from './shipping/feature.js';
const input: ShippingInput = { orderId: 'o1', country: 'JP', weightGrams: 1000 };
function fixture(options: { closed?: boolean; missing?: boolean; fee?: number; unavailable?: boolean; conflict?: boolean } = {}) {
  const calls: string[] = [];
  let version = 1;
  const ports: ShippingPorts = {
    async loadOrder(request) {
      calls.push('load');
      return options.missing ? err({ kind: 'OrderNotFound' }) : ok({ request, order: { id: request.orderId, version, status: options.closed ? 'shipped' : 'open', totalYen: 10000 } });
    },
    async quote(command) {
      calls.push('quote:' + command.service);
      return options.unavailable ? err({ kind: 'QuoteUnavailable' }) : ok({ command, feeYen: options.fee ?? 500 });
    },
    async save(decision) {
      calls.push('save');
      if (options.conflict || version !== decision.expectedVersion) return err({ kind: 'SaveConflict' });
      version++;
      return ok({ orderId: decision.orderId, version });
    },
  };
  return { ports, calls };
}
test('collect retains every field error in deterministic field order', () => {
  assert.deepEqual(collect({ name: err('missing' as const), age: err('invalid' as const), enabled: ok(true) }),
    err([{ field: 'name', error: 'missing' }, { field: 'age', error: 'invalid' }]));
  assert.deepEqual(collect({ name: ok('A'), age: ok(30) }), ok({ name: 'A', age: 30 }));
  assert.deepEqual(collect({}), ok({}));
});
test('collect preserves value types and field/error correlation', () => {
  const combined = collect({ name: ok('A'), age: ok(30) });
  if (!combined.ok) throw new Error('unexpected');
  const name: string = combined.value.name, age: number = combined.value.age;
  assert.equal(name, 'A'); assert.equal(age, 30);
  // @ts-expect-error values are not flattened to an untyped record
  const wrong: number = combined.value.name;
  void wrong;
  const failure = collect({ name: err('missing' as const), age: err(42 as const) });
  if (!failure.ok) for (const issue of failure.error) {
    if (issue.field === 'name') { const message: 'missing' = issue.error; assert.equal(message, 'missing'); }
    else { const code: 42 = issue.error; assert.equal(code, 42); }
  }
});
test('independent validation collects three errors before any IO', async () => {
  const f = fixture();
  const result = await createShippingAction(f.ports).run({ orderId: '', country: 'XX', weightGrams: -1 });
  assert.equal(result.ok, false);
  if (!result.ok && result.error.kind === 'InvalidShipping') assert.deepEqual(result.error.issues.map(i => i.field), ['orderId', 'country', 'weightGrams']);
  else assert.fail('expected validation failure');
  assert.deepEqual(f.calls, []);
});
test('construction performs no IO; a run crosses two explicit IO boundaries then saves', async () => {
  const f = fixture(), action = createShippingAction(f.ports);
  assert.deepEqual(f.calls, []);
  const report = await action.runDetailed(input);
  assert.deepEqual(report.result, ok({ orderId: 'o1', version: 2 }));
  assert.deepEqual(f.calls, ['load', 'quote:domestic', 'save']);
  assert.deepEqual(report.trace.map(t => t.step), ['validate-shipping', 'load-order', 'select-shipping-service', 'fetch-shipping-quote', 'accept-shipping-quote', 'shipping.save.v1']);
  assert(report.trace.every(t => t.status === 'ok'));
});
test('pure decision selects international service before quote lookup', async () => {
  const f = fixture();
  await createShippingAction(f.ports).run({ ...input, country: 'US' });
  assert.deepEqual(f.calls, ['load', 'quote:international', 'save']);
});
for (const [options, expected, calls] of [
  [{ missing: true }, 'OrderNotFound', ['load']],
  [{ closed: true }, 'OrderClosed', ['load']],
  [{ unavailable: true }, 'QuoteUnavailable', ['load', 'quote:domestic']],
  [{ fee: -1 }, 'InvalidQuote', ['load', 'quote:domestic']],
  [{ fee: NaN }, 'InvalidQuote', ['load', 'quote:domestic']],
  [{ fee: 10001 }, 'ShippingTooExpensive', ['load', 'quote:domestic']],
  [{ conflict: true }, 'SaveConflict', ['load', 'quote:domestic', 'save']],
] as const) {
  test(`failure ${expected} stops later phases and never retries`, async () => {
    const f = fixture(options), report = await createShippingAction(f.ports).runDetailed(input);
    assert.deepEqual(report.result, err({ kind: expected })); assert.deepEqual(f.calls, calls);
    assert.equal(report.trace.at(-1)?.status, 'error');
    if (expected !== 'SaveConflict') assert.equal(report.plan, null);
  });
}
test('pure functions can run with supplied values and no ports', () => {
  const valid = validateShipping(input); assert(valid.ok);
  const selected = serviceWorkflow.run({ request: valid.value, order: { id: 'o1', version: 7, status: 'open', totalYen: 10000 } }); assert(selected.ok);
  const result = quoteWorkflow.run({ command: selected.value, feeYen: 10000 }); assert(result.ok);
  assert.equal(result.value.expectedVersion, 7);
  assert.equal(result.value.feeYen, 10000);
});
test('foreign order returned at a boundary is rejected before quoting', async () => {
  const f = fixture();
  f.ports.loadOrder = async request => ok({ request, order: { id: 'other', version: 1, status: 'open', totalYen: 10000 } });
  assert.deepEqual(await createShippingAction(f.ports).run(input), err({ kind: 'OrderMismatch' }));
  assert.deepEqual(f.calls, []);
});
test('interleaved runs do not hide stale data or auto-retry a conflict', async () => {
  const f = fixture(), action = createShippingAction(f.ports);
  const results = await Promise.all([action.run(input), action.run(input)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(results.find(r => !r.ok), err({ kind: 'SaveConflict' }));
  assert.equal(f.calls.filter(c => c === 'save').length, 2);
});
test('plain baseline and process agree on successes and every failure', async () => {
  for (const options of [{}, { missing: true }, { closed: true }, { unavailable: true }, { fee: -1 }, { fee: 10001 }, { conflict: true }]) {
    for (const value of [input, { ...input, country: 'US' }, { ...input, weightGrams: 0 }]) {
      const a = fixture(options), b = fixture(options);
      assert.deepEqual(await createShippingAction(a.ports).run(value), await shippingPlain(b.ports, value));
      assert.deepEqual(a.calls, b.calls);
    }
  }
});
test('unexpected exceptions are not disguised as typed domain errors', async () => {
  const f = fixture(); f.ports.quote = async () => { throw new Error('adapter bug'); };
  await assert.rejects(createShippingAction(f.ports).run(input), /adapter bug/);
  assert.deepEqual(f.calls, ['load']);
});
test('sync pure workflow cannot silently accept an async effect', () => {
  if (false) {
    // @ts-expect-error async IO is not a synchronous pure rule
    workflow('wrong', async (n: number) => ok(n));
    // @ts-expect-error next workflow must accept the previous phase output
    process<ShippingInput>().through(inputWorkflow).through(quoteWorkflow);
    // @ts-expect-error IO must accept the current state
    process<ShippingInput>().effect('wrong', async (_value: number) => ok(1));
    const mutation = bindMutation({ workflow: workflow('number', (n: number) => ok(n)), operation: 'save-number', save: async (n: number) => ok(n) });
    // @ts-expect-error cannot commit a number mutation from an unvalidated shipping input
    process<ShippingInput>().commit(mutation);
  }
});
test('action exposes the full error union and typed save output', async () => {
  const action = createShippingAction(fixture().ports);
  const result = await action.run(input);
  if (result.ok) { const version: number = result.value.version; assert.equal(version, 2); }
  else {
    switch (result.error.kind) {
      case 'InvalidShipping': case 'CorruptOrder': case 'OrderNotFound': case 'OrderClosed': case 'OrderMismatch':
      case 'QuoteUnavailable': case 'InvalidQuote': case 'ShippingTooExpensive': case 'SaveConflict': break;
      default: { const exhaustive: never = result.error; void exhaustive; }
    }
  }
  if (false) {
    // @ts-expect-error loader, quotation, and business errors must not disappear
    const narrowed: Result<{ orderId: string; version: number }, { kind: 'SaveConflict' }> = result;
    void narrowed;
    // @ts-expect-error a decision requires pure business checks
    const forged: ShippingDecision = { orderId: 'o1', expectedVersion: 1, feeYen: 5, service: 'domestic' };
    void forged;
  }
});
