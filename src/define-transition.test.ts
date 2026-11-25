import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTransition, transition, step, defineTarget, defineUseCase, defineUseCaseGroup, ok, err, type Result, type GroupExecution } from './framework/index.js';
declare const proof: unique symbol;
type Validated = { readonly value: number; readonly [proof]: 'validated' };
type Funded = { readonly value: number; readonly [proof]: 'funded' };
const validate = (value: number): Result<Validated, { kind: 'Invalid' }> => value > 0 ? ok({ value } as Validated) : err({ kind: 'Invalid' });
const requireFunds = (value: Validated): Result<Funded, { kind: 'Insufficient' }> => value.value <= 10 ? ok(value as unknown as Funded) : err({ kind: 'Insufficient' });
const evolve = (value: Funded): Result<number, { kind: 'EvolutionFailed' }> => value.value === 7 ? err({ kind: 'EvolutionFailed' }) : ok(value.value * 2);
const declared = defineTransition({ validate, require: [requireFunds], evolve });
test('ordinary functions preserve proof-carrying adjacency, stage order and stop on each failure', () => {
  const decision = transition(declared);
  for (const [input, expected, steps] of [
    [2, ok(4), ['validate', 'require:1', 'evolve']],
    [-1, err({ kind: 'Invalid' }), ['validate']],
    [11, err({ kind: 'Insufficient' }), ['validate', 'require:1']],
    [7, err({ kind: 'EvolutionFailed' }), ['validate', 'require:1', 'evolve']],
  ] as const) {
    const report = decision.inspect(input);
    assert.deepEqual(report.result, expected); assert.deepEqual(report.trace.map(t => t.step), steps);
    assert.equal(report.trace.at(-1)?.status, expected.ok ? 'ok' : 'error');
  }
});
test('requirements are optional and trace labels do not depend on function names', () => {
  const decision = transition(defineTransition({ validate, evolve: (value: Validated) => ok(value.value) }));
  assert.deepEqual(decision.inspect(2), { result: ok(2), trace: [{ step: 'validate', status: 'ok' }, { step: 'evolve', status: 'ok' }] });
  assert.deepEqual(decision.steps, ['validate', 'evolve']);
});
test('named and ordinary stages mix without losing explicit trace names', () => {
  const next = defineTransition({ validate: step('authorize', validate), require: [requireFunds], evolve: step('apply', evolve) });
  assert.deepEqual(transition(next).inspect(2).trace.map(t => t.step), ['authorize', 'require:1', 'apply']);
});
test('declarations use the existing Target, UseCase and group execution paths', async () => {
  const load = async (n: number) => ok(n), save = async (n: number) => ok(n);
  const target = defineTarget({ operation: 'number', load, save }).on(declared);
  const single = defineUseCase({ operation: 'number', load, save, transition: declared });
  const model = defineUseCaseGroup({ operation: (_name: 'double') => 'number', save: async (n: number, _execution: GroupExecution<'double', number>) => ok(n) });
  const group = model.on('double', { load, transition: declared });
  for (const input of [2, -1, 11, 7]) {
    assert.deepEqual(await single.runDetailed(input), await target.runDetailed(input));
    assert.deepEqual(await group.runDetailed(input), await target.runDetailed(input));
  }
});
function typeContracts() {
  const workflow = transition(declared);
  const exact: Result<number, { kind: 'Invalid' } | { kind: 'Insufficient' } | { kind: 'EvolutionFailed' }> = workflow.run(2); void exact;
  const simple = defineTransition({ validate, evolve: value => {
    const n: number = value.value; void n;
    // @ts-expect-error the intermediate value must retain its inferred proof type
    value.other;
    return ok(value.value);
  } });
  const narrow: Result<number, { kind: 'Invalid' }> = transition(simple).run(2); void narrow;
  // @ts-expect-error omitted requirements cannot forge the funded proof
  defineTransition({ validate, evolve });
  // @ts-expect-error require must accept the validated type
  defineTransition({ validate, require: [(n: string) => ok(n)], evolve });
  // @ts-expect-error requirement output must connect to evolution
  defineTransition({ validate, require: [(n: Validated) => ok(n.value)], evolve });
  // @ts-expect-error async stages cannot enter the pure decision path
  defineTransition({ validate: async (n: number) => ok(n), evolve: (n: number) => ok(n) });
  // @ts-expect-error inputs remain tied to validation
  workflow.run('wrong');
  const target = defineTarget({ operation: 'bad-save', load: async (n: number) => ok(n), save: async (_s: string) => ok(1) });
  // @ts-expect-error normalized declarations must still obey the save contract
  target.on(declared);
}
void typeContracts;
test('declaring is effect-free and snapshots named stages without freezing caller-owned objects', () => {
  let calls = 0;
  const validation = { name: 'authorize', rule: (n: number) => { calls++; return ok(n); } };
  const next = defineTransition({ validate: validation, evolve: (n: number) => ok(n * 2) });
  assert.equal(calls, 0);
  validation.name = 'changed'; validation.rule = (_n: number) => ok(999);
  assert(!Object.isFrozen(validation));
  assert(Object.isFrozen(next)); assert(Object.isFrozen(next.require)); assert(Object.isFrozen(next.validate));
  assert.deepEqual(transition(next).inspect(2), { result: ok(4), trace: [{ step: 'authorize', status: 'ok' }, { step: 'evolve', status: 'ok' }] });
  assert.equal(calls, 1);
});
test('multiple dependent requirements preserve distinct intermediate types and labels', () => {
  const describe = (value: Funded): Result<string, { kind: 'DescriptionFailed' }> => value.value === 3 ? err({ kind: 'DescriptionFailed' }) : ok(`value:${value.value}`);
  const finish = (value: string) => ok(value.length);
  const flow = transition(defineTransition({ validate, require: [requireFunds, describe], evolve: finish }));
  assert.deepEqual(flow.inspect(2), { result: ok(7), trace: [
    { step: 'validate', status: 'ok' }, { step: 'require:1', status: 'ok' }, { step: 'require:2', status: 'ok' }, { step: 'evolve', status: 'ok' },
  ] });
  const denied = flow.inspect(3); assert.deepEqual(denied.result, err({ kind: 'DescriptionFailed' }));
  assert.equal(denied.trace.at(-1)?.step, 'require:2');
});
function moreTypeContracts() {
  const widened: readonly typeof requireFunds[] = [requireFunds];
  // @ts-expect-error a widened array cannot prove dependent adjacency and must not silently become an empty pipeline
  defineTransition({ validate, require: widened, evolve });
  // @ts-expect-error async evolution remains an IO boundary
  defineTransition({ validate, evolve: async (value: Validated) => ok(value.value) });
  // @ts-expect-error async requirements cannot masquerade as pure functions
  defineTransition({ validate, require: [async (value: Validated) => ok(value)], evolve });
}
void moreTypeContracts;
