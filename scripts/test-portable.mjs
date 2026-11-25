import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test tooling uses Node; the bundled consumer has only standard runtime globals.
const source = `
import { workflow, combine, collectEffects, foldEach, business, withReplay, defineUseCaseGroup, replayOperations, defineApplication, operation, defineTransition, withInput, ok, fromThrowable, fromPromise, process as effectProcess, collectEach, err } from './dist/index.js';
export const result = (async () => {
  if ('process' in globalThis || 'Buffer' in globalThis || 'require' in globalThis) throw new Error('Node global leaked');
  const firstFailure = err('Invalid');
  if (combine([ok(1), firstFailure, err('Later')]) !== firstFailure) throw new Error('Tuple failure changed');
  const tuple = combine([ok('label'), ok(2)]);
  if (!tuple.ok || tuple.value[0] !== 'label' || tuple.value[1] !== 2 || !Object.isFrozen(tuple.value)) throw new Error('Tuple composition failed');
  const ordinary = business({ name: 'portable-business', load: async input => ok(input), save: async value => ok(value), operations: { double: [n => ok(n * 2)] } });
  const ordinaryResult = await ordinary.double(3);
  const ordinaryReport = await ordinary.double.runDetailed(3, { input: value => value, result: value => value.ok });
  if (ordinaryReport.observations.length !== 3 || ordinaryReport.observationErrors.length !== 0) throw new Error('Business observation failed');
  if (!ordinaryResult.ok || ordinaryResult.value !== 6) throw new Error('Business operation failed');
  let detailedReads = 0;
  const detailed = business({ name: 'portable-detailed', load: effectProcess().effect('read', async input => { detailedReads++; return ok(input + 1); }), save: async value => ok(value), operations: { double: [n => ok(n * 2)] } });
  const detailedReport = await detailed.double.runDetailed(3, { input: (_value, step) => step, result: result => result.ok });
  if (!detailedReport.result.ok || detailedReport.result.value !== 8 || detailedReads !== 1 || detailedReport.trace.map(entry => entry.step).join(',') !== 'read,portable-detailed.double:load,run:1,portable-detailed.double' || detailedReport.observations.length !== 3) throw new Error('Detailed load failed');
  const proof = Symbol('portable-proof');
  class Domain { #value = 7; value() { return this.#value; } }
  let opaqueWrites = 0;
  const opaque = business({ name: 'portable-opaque', load: async input => ok(input), save: async value => { opaqueWrites++; return ok(value); }, operations: { save: [value => ok(value)] } });
  const symbolValue = { value: 2, [proof]: true }, instance = new Domain();
  const symbolReport = await opaque.save.runDetailed(symbolValue), classReport = await opaque.save.runDetailed(instance);
  if (!symbolReport.result.ok || symbolReport.result.value !== symbolValue || !symbolReport.result.value[proof] || symbolReport.plan.inputStatus !== 'unavailable') throw new Error('Opaque symbol decision failed');
  if (!classReport.result.ok || classReport.result.value !== instance || classReport.result.value.value() !== 7 || classReport.plan.inputStatus !== 'unavailable' || opaqueWrites !== 2) throw new Error('Opaque class decision failed');
  let snapshotRuns = 0;
  const guardedRequest = withReplay({ run: async input => { snapshotRuns++; return ok({ kind: 'committed', value: input.amount + input.date.getTime() + input.map.get('amount') }); } }, { lookup: () => ok({ kind: 'missing' }), resolveAfter: () => false });
  const requestResult = await guardedRequest.run({ amount: 2, date: new Date(0), map: new Map([['amount', 2]]) });
  const lostProof = await guardedRequest.run({ amount: 2, [proof]: true });
  if (!requestResult.ok || requestResult.value.value !== 4 || lostProof.ok || lostProof.error.kind !== 'ReplayInputNotCloneable' || snapshotRuns !== 1) throw new Error('Replay request snapshot failed');
  let receipt = null, writes = 0;
  const model = defineUseCaseGroup({
    operation: name => 'portable',
    save: async value => { writes++; receipt = value; return ok({ kind: 'committed', value }); },
    replay: { lookup: () => ok(receipt === null ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: [] },
  });
  const command = model.on('double', {
    load: async input => ok(input),
    transition: defineTransition({ validate: n => ok(n), require: [withInput(n => ok(n * 2))], evolve: pair => ok(pair.value) }),
  });
  const first = await command.runDetailed(2), replay = await command.runDetailed(2);
  const app = await defineApplication({ initial: () => 100,
    operations: replayOperations({ double: command }, (before, after) => before + after),
    view: state => state.data,
  }).start();
  await app.dispatch({ type: 'double', input: 2 });
  const crashed = await defineApplication({ initial: () => 7,
    operations: { broken: operation({ run: async () => { throw () => 'not cloneable'; } }, before => before) },
    view: state => state.kind,
  }).start();
  await crashed.dispatch({ type: 'broken', input: null });
  const isolated = await defineApplication({ initial: () => 0,
    operations: { add: operation({ run: async input => ok(input.amount) }, (before, amount) => before + amount) },
    view: state => state.data,
  }).start();
  const event = { type: 'add', input: { amount: 3 } };
  const pending = isolated.dispatch(event); event.input.amount = 99; await pending;
  const ownedRevision = isolated.snapshot().revision;
  let rejectedEvent = false;
  try { await isolated.dispatch({ type: 'add', input: { amount: 500, [proof]: true } }); }
  catch (cause) { rejectedEvent = cause.name === 'DataCloneError'; }
  if (!rejectedEvent || isolated.snapshot().revision !== ownedRevision || isolated.snapshot().view !== 3) throw new Error('Application event ownership failed');
  const presentation = await defineApplication({ initial: () => 7, operations: {}, view: state => ({ [proof]: true, render: () => state.data }) }).start();
  if (!presentation.snapshot().view[proof] || presentation.snapshot().view.render() !== 7) throw new Error('Presentation values were incorrectly cloned');
  const collections = await defineApplication({ initial: () => ({ rows: [{ amount: 2 }], date: new Date(0), map: new Map([['amount', 2]]) }), operations: {}, view: state => state.data.rows[0].amount + state.data.date.getTime() + state.data.map.get('amount') }).start();
  if (collections.snapshot().view !== 4 || collections.snapshot().state.data.rows.length !== 1) throw new Error('Collection state snapshots failed');
  const syncFailure = fromThrowable(() => { throw 'offline'; }, () => 'Unavailable')();
  const asyncFailure = await fromPromise(async () => { throw 'offline'; }, () => 'Unavailable')();
  if (syncFailure.ok || asyncFailure.ok || syncFailure.error !== 'Unavailable' || asyncFailure.error !== 'Unavailable') throw new Error('Boundary adaptation failed');
  const observed = workflow('increment', n => ok(n + 1)).inspect(2, { input: x => x, result: r => r.ok ? r.value : null });
  if (observed.observations[0].input !== 2 || observed.observations[0].result !== 3) throw new Error('Workflow capture failed');
  const deliveries = await collectEffects(async (n, index) => n > 0 ? ok(n) : err({ kind: 'Offline', index }), { concurrency: 2 })([1, -1, 2]);
  if (deliveries.ok || deliveries.error.length !== 1 || deliveries.error[0].index !== 1) throw new Error('Effect collection failed');
  const budgetFold = foldEach(() => 10, (remaining, amount, index) => amount > remaining ? err({ kind: 'InsufficientBudget', index }) : ok(remaining - amount));
  const insufficient = budgetFold([6, 5, 1]);
  if (insufficient.ok || insufficient.error.index !== 1 || budgetFold([6, 4]).value !== 0) throw new Error('Dependent fold failed');
  const collected = collectEach(n => n > 0 ? ok(n) : err('Invalid'))([1, -2, 3, -4]);
  if (collected.ok || collected.error.length !== 2 || collected.error[0].index !== 1 || collected.error[1].index !== 3) throw new Error('Collection validation failed');
  const delivered = await effectProcess().effect('send', async input => ok(input + 1)).effect('ack', async value => ok(value * 2)).runDetailed(3);
  if (!delivered.result.ok || delivered.result.value !== 8 || delivered.plan !== null || delivered.trace.length !== 2) throw new Error('Direct process failed');
  const nested = await effectProcess().effect('command', { runDetailed: async value => ({ result: ok(value + 1), trace: [{ step: 'inside', status: 'ok' }], plan: null }) }).runDetailed(4);
  if (!nested.result.ok || nested.result.value !== 5 || nested.trace.map(entry => entry.step).join(',') !== 'inside,command') throw new Error('Detailed process failed');
  return { queuedValue: isolated.snapshot().view, crash: crashed.snapshot().view, appValue: app.snapshot().view, first: first.result.value.kind, value: first.result.value.value, steps: first.attempt.trace.length, replay: replay.result.value.kind, attempt: replay.attempt, writes };
})();`;
const bundled = await build({ stdin: { contents: source, resolveDir: root, loader: 'js' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Portable', write: false, metafile: true });
assert.equal(Object.keys(bundled.metafile.outputs).flatMap(key => bundled.metafile.outputs[key].imports).length, 0);
const context = { structuredClone };
runInNewContext(bundled.outputFiles[0].text, context);
const result = JSON.parse(JSON.stringify(await context.Portable.result));
assert.deepEqual(result, { queuedValue: 3, crash: 'crashed', appValue: 100, first: 'committed', value: 4, steps: 5, replay: 'replayed', attempt: null, writes: 1 });
console.log('Browser bundle executed without Node globals: function declarations, opaque domain decisions, replay and application snapshots, input-preserving composition, group commit, direct effect process, collection validation, replay and application lifecycle verified.');
