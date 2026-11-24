import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test tooling uses Node; the bundled consumer has only standard runtime globals.
const source = `
import { defineUseCaseGroup, replayOperations, defineApplication, operation, step, ok } from './dist/index.js';
export const result = (async () => {
  if ('process' in globalThis || 'Buffer' in globalThis || 'require' in globalThis) throw new Error('Node global leaked');
  let receipt = null, writes = 0;
  const model = defineUseCaseGroup({
    operation: name => 'portable',
    save: async value => { writes++; receipt = value; return ok({ kind: 'committed', value }); },
    replay: { lookup: () => ok(receipt === null ? { kind: 'missing' } : { kind: 'found', value: receipt }), resolveAfter: [] },
  });
  const command = model.on('double', {
    load: async input => ok(input),
    transition: { validate: step('validate', n => ok(n)), require: [], evolve: step('double', n => ok(n * 2)) },
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
  return { crash: crashed.snapshot().view, appValue: app.snapshot().view, first: first.result.value.kind, value: first.result.value.value, steps: first.attempt.trace.length, replay: replay.result.value.kind, attempt: replay.attempt, writes };
})();`;
const bundled = await build({ stdin: { contents: source, resolveDir: root, loader: 'js' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Portable', write: false, metafile: true });
assert.equal(Object.keys(bundled.metafile.outputs).flatMap(key => bundled.metafile.outputs[key].imports).length, 0);
const context = { structuredClone };
runInNewContext(bundled.outputFiles[0].text, context);
const result = JSON.parse(JSON.stringify(await context.Portable.result));
assert.deepEqual(result, { crash: 'crashed', appValue: 100, first: 'committed', value: 4, steps: 4, replay: 'replayed', attempt: null, writes: 1 });
console.log('Browser bundle executed without Node globals: group commit, detailed trace, replay, application registration and exception lifecycle verified.');
