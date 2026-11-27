import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test tooling uses Node; the bundled consumer has only standard runtime globals.
const source = `
import { h as authoringH, Fragment as AuthoringFragment, createContext as authoringContext, useContext as authoringUseContext, useOperation as authoringUseOperation, Operation as AuthoringOperation, operationKey as authoringKey, createApplication as mountAuthoring } from './dist/authoring.js';
import { exploreModel, sampleModel, sampleModelAsync } from './dist/testing.js';
import { retryEffect } from './dist/index.js';
import { describeFlow, flowMermaid, auditRecord, inTransaction, createSyncTransaction, workflow, combine, collectEffects, foldEach, business, withReplay, defineUseCaseGroup, replayOperations, defineApplication, operation, defineTransition, withInput, ok, fromThrowable, fromPromise, process as effectProcess, collectEach, err } from './dist/index.js';
export const result = (async () => {
  const explored = exploreModel({ initial: [0], key: String, events: n => n < 2 ? [1] : [], step: (n, e) => ({ state: n + e, output: n + e }), check: (n, e, expected) => n + e === expected.output, limits: { depth: 2, states: 3, transitions: 2 } });
  if (explored.kind !== 'passed' || explored.states !== 3 || explored.transitions !== 2) throw new Error('Portable finite exploration failed');
  const sampled = sampleModel({ initial: [0], seed: 0, events: () => [1], step: (n, e) => ({ state: n + e, output: n + e }), check: (_n, _e, expected) => expected.output < 2, limits: { cases: 1, length: 4, shrinkAttempts: 20 } });
  if (sampled.kind !== 'counterexample' || sampled.witness.events.length !== 2 || sampled.shrink !== 'one-deletion-minimal') throw new Error('Portable seeded sampling failed');
  const asyncSampled = await sampleModelAsync({ initial: [0], seed: 0, events: () => [1], step: (n, e) => ({ state: n + e, output: n + e }), check: async (_n, _e, expected) => expected.output < 2, limits: { cases: 1, length: 4, shrinkAttempts: 20 } });
  if (JSON.stringify(asyncSampled) !== JSON.stringify(sampled)) throw new Error('Portable async sampling failed');
  const reducedPayload = sampleModel({ initial: [0], seed: 0, events: () => [100], step: (n, e) => ({ state: n + e, output: n + e }), check: () => false, shrinkEvent: e => e > 0 ? [0] : [], limits: { cases: 1, length: 1, shrinkAttempts: 20 } });
  if (reducedPayload.kind !== 'counterexample' || reducedPayload.witness.events[0] !== 0 || reducedPayload.original.events[0] !== 100) throw new Error('Portable payload shrinking failed');
  const reducedInitial = await sampleModelAsync({ initial: [100], seed: 0, events: () => [], step: n => ({ state: n, output: n }), check: async () => true, invariant: n => n <= 0, shrinkInitial: n => n > 1 ? [0, 1] : [], limits: { cases: 1, length: 0, shrinkAttempts: 20 } });
  if (reducedInitial.kind !== 'counterexample' || reducedInitial.witness.initial !== 1 || reducedInitial.original.initial !== 100) throw new Error('Portable initial shrinking failed');
  if ('process' in globalThis || 'Buffer' in globalThis || 'require' in globalThis) throw new Error('Node global leaked');
  const authoringDependency = authoringContext(), authoringOperationId = 'portable-authoring';
  let authoringWrites = 0;
  function usePortableBusiness() {
    const dependency = authoringUseContext(authoringDependency);
    let receipt = null;
    return authoringUseOperation({ name: authoringOperationId,
      load: effectProcess().effect('authoring-read-input', async input => ok(input + dependency)),
      execute: effectProcess()
        .through(workflow('authoring-increment', input => ok(input + 1)))
        .effect('authoring-read-policy', async value => ok({ value, multiplier: 2 }))
        .through(workflow('authoring-double', input => ok(input.value * input.multiplier))),
      save: async value => { authoringWrites++; receipt = value; return ok({ kind: 'committed', value }); },
      replay: { lookup: () => ok(receipt === null ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: () => false },
    });
  }
  const authoringOperation = authoringKey(authoringOperationId, usePortableBusiness);
  function PortableBusiness() {
    const handler = usePortableBusiness();
    return authoringH(AuthoringOperation, { operation: authoringOperation, handler });
  }
  const authoringEvents = [];
  const authoringApp = mountAuthoring(authoringH(AuthoringFragment, null, authoringH(authoringDependency.Provider, { value: 10 }, authoringH(PortableBusiness, null))), { observeExecution: event => authoringEvents.push(event) });
  const authoringCapture = { input: (_value, step) => step, result: result => result.ok };
  const authoringFirst = await authoringApp.inspect(authoringOperation, 2, authoringCapture);
  const authoringReplay = await authoringApp.inspect(authoringOperation, 2, authoringCapture);
  if (authoringFirst.observationErrors.length || !authoringFirst.observations.some(row => row.step === 'authoring-read-policy') || authoringReplay.observations.some(row => row.step === 'authoring-double')) throw new Error('Portable selected authoring capture failed');
  if (!authoringFirst.result.ok || authoringFirst.result.value.value !== 26 || authoringReplay.attempt !== null || authoringWrites !== 1 || !authoringEvents.some(event => event.kind === 'span-started' && event.step === 'authoring-double')) throw new Error('Portable experimental authoring failed');
  let retryCalls = 0;
  const retried = await retryEffect(async n => ++retryCalls === 1 ? err('Offline') : ok(n), { maxAttempts: 2, decide: () => ({ kind: 'retry', safety: 'not-applied', delayMs: 0 }) })(3);
  if (!retried.ok || retried.value !== 3 || retryCalls !== 2) throw new Error('Portable bounded retry failed');
  const projectedRead = await effectProcess().effect('read', async input => ok(input.id + 1), (context, row) => ({ ...context, row })).run({ id: 2, label: 'kept' });
  if (!projectedRead.ok || projectedRead.value.row !== 3 || projectedRead.value.label !== 'kept') throw new Error('Portable effect projection failed');
  const hiddenOperations = { go: [n => ok(n + 1)] }; Object.defineProperty(hiddenOperations, 'go', { enumerable: false });
  const hiddenCommand = business({ name: 'hidden', load: async n => ok(n), save: async n => ok(n), operations: hiddenOperations });
  const hiddenResult = await hiddenCommand.go(2);
  if (!hiddenResult.ok || hiddenResult.value !== 3) throw new Error('Portable operation table failed');
  const transactionCalls = [];
  const transaction = createSyncTransaction({ begin() { transactionCalls.push('begin'); }, commit() { transactionCalls.push('commit'); }, rollback() { transactionCalls.push('rollback'); } });
  const transactionResult = transaction.run(() => ok(7));
  transaction.run(() => err('Denied'));
  if (!transactionResult.ok || transactionResult.value !== 7 || transactionCalls.join(',') !== 'begin,commit,begin,rollback') throw new Error('Portable transaction failed');
  const rejectedObserverCalls = [], rejectedObserverEvents = [];
  const observedTransaction = createSyncTransaction({ begin() { rejectedObserverCalls.push('begin'); }, commit() { rejectedObserverCalls.push('commit'); }, rollback() { rejectedObserverCalls.push('rollback'); } }, async event => { rejectedObserverEvents.push(event.kind); await Promise.resolve(); throw new Error('diagnostic rejection'); });
  const originalSuccess = ok(9), originalFailure = err('Denied');
  if (observedTransaction.run(() => originalSuccess) !== originalSuccess || observedTransaction.run(() => originalFailure) !== originalFailure) throw new Error('Portable observer changed Result identity');
  await new Promise(resolve => setTimeout(resolve, 0));
  if (rejectedObserverCalls.join(',') !== 'begin,commit,begin,rollback' || rejectedObserverEvents.join(',') !== 'started,committed,started,rolled-back') throw new Error('Portable rejected transaction observer failed');
  const deniedTransaction = err('Denied');
  const asyncOutcome = await inTransaction({ transaction: async work => work({ id: 1 }) }, () => deniedTransaction);
  if (asyncOutcome !== deniedTransaction) throw new Error('Portable callback transaction failed');
  const audit = auditRecord({ actorId: 'host', operationId: 'request-1', definitionVersion: 'v1', occurredAt: '2026-11-25T00:00:00.000Z' }, 'submit', { targetType: 'expense', targetId: 'e1', beforeVersion: 1, afterVersion: 2 });
  if (!Object.isFrozen(audit) || audit.schema !== 'koyuki.audit.v1' || audit.afterVersion !== 2) throw new Error('Portable audit failed');
  const executionEvents = [];
  const executionApp = defineApplication({ initial: () => 0, operations: { go: operation({ run: async n => ok(n), runDetailed: async n => ({ result: ok(n), trace: [{ step: 'portable-step', status: 'ok' }], plan: null }) }, (_, n) => n) }, view: state => state.data });
  const executionSession = await executionApp.start({ sessionId: 'portable', clock: () => 0, observeExecution: event => { executionEvents.push(event); } });
  const subscriptionValues = [];
  const disposeSubscription = executionSession.subscribe(async snapshot => { subscriptionValues.push(snapshot.view); await Promise.resolve(); throw new Error('presentation rejection'); });
  const executionResult = await executionSession.dispatch({ type: 'go', input: 3 });
  await new Promise(resolve => setTimeout(resolve, 0)); disposeSubscription();
  if (subscriptionValues.join(',') !== '0,0,3') throw new Error('Portable subscriber rejection changed accepted updates');
  if (!executionResult.ok || executionResult.value.state.data !== 3 || executionEvents.filter(event => !event.kind.startsWith('span-')).map(event => event.kind).join(',') !== 'queued,started,step,completed' || executionEvents.some(event => event.executionId !== 'portable/1')) throw new Error('Portable execution observation failed');
  const describedFlow = workflow('portable-rule', n => ok(n)).then('portable-next', n => ok(n + 1));
  if (describeFlow(describedFlow).nodes.length !== 2 || !flowMermaid(describedFlow).startsWith('flowchart TD')) throw new Error('Portable static flow description failed');
  const firstFailure = err('Invalid');
  if (combine([ok(1), firstFailure, err('Later')]) !== firstFailure) throw new Error('Tuple failure changed');
  const tuple = combine([ok('label'), ok(2)]);
  if (!tuple.ok || tuple.value[0] !== 'label' || tuple.value[1] !== 2 || !Object.isFrozen(tuple.value)) throw new Error('Tuple composition failed');
  const ordinary = business({ name: 'portable-business', load: async input => ok(input), save: async value => ok(value), operations: { double: [n => ok(n * 2)] } });
  const liveEvents = [];
  const liveApplication = defineApplication({ initial: () => 0, operations: { go: operation(ordinary.double, (_, n) => n) }, view: state => state.data });
  const liveSession = await liveApplication.start({ clock: () => 0, observeExecution: event => liveEvents.push(event) });
  const liveResult = await liveSession.dispatch({ type: 'go', input: 3 });
  if (!liveResult.ok || liveResult.value.state.data !== 6 || !liveEvents.some(event => event.kind === 'span-started' && event.step === 'run:1') || !liveEvents.some(event => event.kind === 'span-completed' && event.step === 'application.project' && event.status === 'ok')) throw new Error('Portable live spans failed');
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
  const capturedProcess = await effectProcess().effect('load', async input => ok(input + 1)).through(workflow('double', n => ok(n * 2))).runDetailed(3, { input: value => value, result: result => result.ok ? result.value : null });
  if (!capturedProcess.result.ok || capturedProcess.result.value !== 8 || capturedProcess.observations.length !== 2 || capturedProcess.observations[0].input !== 3 || capturedProcess.observations[1].result !== 8 || capturedProcess.observationErrors.length) throw new Error('Process capture failed');
  let captureWrites = 0;
  const rejectedCapture = await effectProcess().effect('write', async input => { captureWrites++; return ok(input); }).runDetailed(3, {
    input: () => null, result: async () => { await Promise.resolve(); throw new Error('private capture'); },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!rejectedCapture.result.ok || rejectedCapture.result.value !== 3 || captureWrites !== 1 || rejectedCapture.observationErrors.length !== 1 || rejectedCapture.observationErrors[0].phase !== 'result') throw new Error('Rejected native capture changed IO');
  const delivered = await effectProcess().effect('send', async input => ok(input + 1)).effect('ack', async value => ok(value * 2)).runDetailed(3);
  if (!delivered.result.ok || delivered.result.value !== 8 || delivered.plan !== null || delivered.trace.length !== 2) throw new Error('Direct process failed');
  const nested = await effectProcess().effect('command', { runDetailed: async value => ({ result: ok(value + 1), trace: [{ step: 'inside', status: 'ok' }], plan: null }) }).runDetailed(4);
  if (!nested.result.ok || nested.result.value !== 5 || nested.trace.map(entry => entry.step).join(',') !== 'inside,command') throw new Error('Detailed process failed');
  return { queuedValue: isolated.snapshot().view, crash: crashed.snapshot().view, appValue: app.snapshot().view, first: first.result.value.kind, value: first.result.value.value, steps: first.attempt.trace.length, replay: replay.result.value.kind, attempt: replay.attempt, writes };
})();`;
const bundled = await build({ stdin: { contents: source, resolveDir: root, loader: 'js' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Portable', write: false, metafile: true });
assert.equal(Object.keys(bundled.metafile.outputs).flatMap(key => bundled.metafile.outputs[key].imports).length, 0);
const context = { structuredClone, setTimeout, clearTimeout };
runInNewContext(bundled.outputFiles[0].text, context);
const result = JSON.parse(JSON.stringify(await context.Portable.result));
assert.deepEqual(result, { queuedValue: 3, crash: 'crashed', appValue: 100, first: 'committed', value: 4, steps: 5, replay: 'replayed', attempt: null, writes: 1 });
console.log('Browser bundle executed without Node globals: function declarations, opaque domain decisions, replay and application snapshots, input-preserving composition, group commit, direct effect process, collection validation, replay and application lifecycle verified.');
