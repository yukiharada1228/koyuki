import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, process, ok, err, type Result } from './framework/index.js';
type Found = { readonly kind: 'found'; readonly id: string; readonly version: number };
type Missing = { readonly kind: 'missing'; readonly newId: string };
type Lookup = Found | Missing;
const isFound = (value: Lookup): value is Found => value.kind === 'found';
const found = (value: Found): Result<{ readonly updated: string }, 'UpdateDenied'> => value.version > 0 ? ok({ updated: value.id }) : err('UpdateDenied');
const missing = (value: Missing): Result<{ readonly created: string }, 'CreateDenied'> => value.newId ? ok({ created: value.newId }) : err('CreateDenied');
const choose = workflow('check-lookup', (value: Lookup): Result<Lookup, 'InvalidLookup'> => ok(value)).branch('found', isFound, {
  yes: workflow('update', found), no: workflow('create', missing),
});
test('type guard routes each Union member to a function requiring its narrowed payload', () => {
  assert.deepEqual(choose.inspect({ kind: 'found', id: 'c1', version: 2 }), {
    result: ok({ updated: 'c1' }), trace: [{ step: 'check-lookup', status: 'ok' }, { step: 'found:yes', status: 'ok' }, { step: 'update', status: 'ok' }],
  });
  assert.deepEqual(choose.inspect({ kind: 'missing', newId: 'c2' }), {
    result: ok({ created: 'c2' }), trace: [{ step: 'check-lookup', status: 'ok' }, { step: 'found:no', status: 'ok' }, { step: 'create', status: 'ok' }],
  });
});
test('narrowed branch failure stops subsequent I/O and keeps the original failure', async () => {
  let saves = 0;
  const flow = process<Lookup>().through(choose).effect('save', async output => { saves++; return ok(output); });
  assert.deepEqual(await flow.run({ kind: 'found', id: 'c1', version: 0 }), err('UpdateDenied'));
  assert.deepEqual(await flow.run({ kind: 'missing', newId: '' }), err('CreateDenied'));
  assert.equal(saves, 0);
});
test('capture evaluates the predicate once and records only the selected typed rule', () => {
  let calls = 0;
  const flow = workflow('lookup', (value: Lookup) => ok(value)).branch('found', (value): value is Found => { calls++; return isFound(value); }, {
    yes: workflow('update', found), no: workflow('create', missing),
  });
  const report = flow.inspect({ kind: 'missing', newId: 'c1' }, { input: (_value, step) => step, result: value => value.ok });
  assert.equal(calls, 1);
  assert.deepEqual(report.observations.map(item => item.step), ['lookup', 'create']);
});
test('a failed prior rule evaluates neither guard nor branch', () => {
  let calls = 0;
  const flow = workflow('lookup', (_input: string): Result<Lookup, 'LookupFailed'> => err('LookupFailed')).branch('found', (value): value is Found => { calls++; return isFound(value); }, {
    yes: workflow('update', found), no: workflow('create', missing),
  });
  assert.deepEqual(flow.inspect('x'), { result: err('LookupFailed'), trace: [{ step: 'lookup', status: 'error' }] });
  assert.equal(calls, 0);
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<ReturnType<typeof choose.run>, Result<{ readonly updated: string } | { readonly created: string }, 'InvalidLookup' | 'UpdateDenied' | 'CreateDenied'>> = true;
void exact;
if (false) {
  const start = workflow('start', (value: Lookup) => ok(value));
  // @ts-expect-error the preceding Union output has not been narrowed for a single-variant workflow
  process<Lookup>().through(workflow('update', found));
  // @ts-expect-error a wider yes consumer must not widen the guard and erase the false branch input
  start.branch('bad-no', isFound, { yes: workflow('wide', (value: Lookup) => ok(value.kind)), no: workflow('wrong', found) });
  // @ts-expect-error an unannotated constant boolean does not prove any state refinement
  start.branch('constant', _value => true, { yes: workflow('update', found), no: workflow('create', missing) });
  // @ts-expect-error the yes branch cannot consume the opposite variant
  start.branch('wrong', isFound, { yes: workflow('create', missing), no: workflow('update', found) });
  // @ts-expect-error a boolean predicate does not prove that either branch receives a narrowed value
  start.branch('boolean', (_value: Lookup): boolean => true, { yes: workflow('update', found), no: workflow('create', missing) });
  // @ts-expect-error the type guard does not prove an additional literal version constraint
  start.branch('too-narrow', isFound, { yes: workflow('narrow', (value: Found & { version: 1 }) => ok(value.id)), no: workflow('create', missing) });
}
test('async identification connects to narrowed branches before one final persistence effect', async () => {
  const saved: ({ readonly updated: string } | { readonly created: string })[] = [];
  const flow = process<string>()
    .effect('identify', async (id: string): Promise<Result<Lookup, 'Offline'>> => id === 'offline' ? err('Offline') : ok(id === 'new' ? { kind: 'missing', newId: 'new-id' } : { kind: 'found', id, version: 1 }))
    .through(choose)
    .effect('save', async decision => { saved.push(decision); return ok(decision); });
  assert.deepEqual(await flow.run('old-id'), ok({ updated: 'old-id' }));
  assert.deepEqual(await flow.run('new'), ok({ created: 'new-id' }));
  assert.deepEqual(await flow.run('offline'), err('Offline'));
  assert.deepEqual(saved, [{ updated: 'old-id' }, { created: 'new-id' }]);
});
