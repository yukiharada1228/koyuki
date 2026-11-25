import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, transition, step, ok, err, type WorkflowCapture, type Result } from './framework/index.js';
const numeric: WorkflowCapture<number, number | 'error'> = {
  input: value => Number(value), result: result => result.ok ? Number(result.value) : 'error',
};
test('inspection captures selected before/after values for every executed rule without re-execution', () => {
  let calls = 0;
  const flow = workflow('increment', (n: number) => { calls++; return ok(n + 1); }).then('double', n => { calls++; return ok(n * 2); });
  assert.deepEqual(flow.inspect(2, numeric), { result: ok(6), trace: [{ step: 'increment', status: 'ok' }, { step: 'double', status: 'ok' }],
    observations: [{ step: 'increment', input: 2, result: 3 }, { step: 'double', input: 3, result: 6 }] });
  assert.equal(calls, 2);
  assert.deepEqual(flow.inspect(2), { result: ok(6), trace: [{ step: 'increment', status: 'ok' }, { step: 'double', status: 'ok' }] });
  assert.equal(calls, 4);
});
test('failed rules are observed and later rules are not executed or observed', () => {
  const failure = { kind: 'Denied' as const };
  const flow = workflow('deny', (n: number): Result<number, typeof failure> => err(failure)).then('later', () => { assert.fail('must stop'); });
  const report = flow.inspect(1, numeric); assert(!report.result.ok); assert.equal(report.result.error, failure);
  assert.deepEqual(report.observations, [{ step: 'deny', input: 1, result: 'error' }]);
});
test('branch inspection records only the chosen rules, and transition iteration supports capture', () => {
  const flow = workflow('start', (n: number) => ok(n)).branch('choose', n => n > 0, {
    yes: workflow('yes', (n: number) => ok(n + 1)), no: workflow('no', (n: number) => ok(n - 1)),
  });
  assert.deepEqual(flow.inspect(1, numeric).observations.map(o => o.step), ['start', 'yes']);
  assert.deepEqual(flow.inspect(-1, numeric).observations.map(o => o.step), ['start', 'no']);
  const declared = transition({ validate: step('validate', (n: number) => ok(n)), require: [] as const, evolve: step('evolve', (n: number) => ok(n * 2)) });
  assert.deepEqual(declared.inspect(2, numeric).observations, [{ step: 'validate', input: 2, result: 2 }, { step: 'evolve', input: 2, result: 4 }]);
});
test('projection precedes clone, excludes secrets and isolates snapshots from later mutations', () => {
  const input = { visible: { count: 1 }, secret: () => 'not cloneable' };
  const flow = workflow('change', (value: typeof input) => { value.visible.count = 2; return ok(value); });
  const report = flow.inspect(input, {
    input: value => (value as typeof input).visible,
    result: result => result.ok ? (result.value as typeof input).visible : null,
  });
  input.visible.count = 99;
  assert.deepEqual(report.observations, [{ step: 'change', input: { count: 1 }, result: { count: 2 } }]);
  assert(Object.isFrozen(report.observations)); assert(Object.isFrozen(report.observations[0]));
  assert(!Object.isFrozen(input));
});
test('capture defects propagate and each invocation has its own observations', () => {
  let calls = 0;
  const flow = workflow('run', (n: number) => { calls++; return ok(n); });
  const defect = new Error('capture');
  assert.throws(() => flow.inspect(1, { input: () => { throw defect; }, result: r => r }), error => error === defect);
  assert.equal(calls, 0);
  assert.throws(() => flow.inspect(1, { input: x => x, result: () => () => 'uncloneable' }), /clone/i);
  assert.equal(calls, 1);
  assert.deepEqual(flow.inspect(3, numeric).observations, [{ step: 'run', input: 3, result: 3 }]);
});
