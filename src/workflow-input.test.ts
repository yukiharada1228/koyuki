import test from 'node:test';
import assert from 'node:assert/strict';
import { business, workflow, ok, err, type Result } from './framework/index.js';
test('a workflow run function can be reused as an ordinary business rule without a receiver wrapper', async () => {
  const validation = workflow('validate', (text: string): Result<string, 'Empty'> => text.trim() ? ok(text.trim()) : err('Empty'));
  const length = validation.then('length', text => ok(text.length));
  let saves = 0;
  const commands = business({ name: 'reuse.v1', load: async (input: string) => ok(input),
    save: async (value: number) => { saves++; return ok(value); }, operations: { measure: [length.run] } });
  assert.deepEqual(await commands.measure(' name '), ok(4));
  assert.deepEqual(await commands.measure(' '), err('Empty'));
  assert.equal(saves, 1);
  // Reusing one workflow must not redirect a different instance's callback.
  const double = validation.then('double', text => ok(text.length * 2)).run;
  assert.deepEqual(double(' name '), ok(8));
  assert.deepEqual(length.run(' name '), ok(4));
});
test('a reused workflow preserves rule defects rather than changing them into a business rejection', async () => {
  const defect = new Error('broken rule');
  const broken = workflow('broken', (_text: string): Result<number, never> => { throw defect; });
  let saves = 0;
  const commands = business({ name: 'reuse-defect.v1', load: async (input: string) => ok(input),
    save: async (value: number) => { saves++; return ok(value); }, operations: { measure: [broken.run] } });
  await assert.rejects(commands.measure('name'), error => error === defect);
  assert.equal(saves, 0);
});
