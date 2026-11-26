import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindMutation, workflow, ok, describeView } from './framework/index.js';
type View = ReturnType<ReturnType<typeof bindMutation>['view']>;

test('standalone descriptions reject cycles and traverse deep finite views without recursion', () => {
  const cycle: { kind: 'mutation'; name: string; child: View } = { kind: 'mutation', name: 'cycle', child: { kind: 'done' } };
  cycle.child = cycle;
  assert.throws(() => describeView(cycle), /CyclicView/);
  let root: View = { kind: 'done' };
  for (let index = 0; index < 20000; index++) root = { kind: 'mutation', name: String(index), child: root };
  let cursor = describeView(root);
  for (let index = 19999; index >= 0; index--) {
    assert(cursor !== null && typeof cursor === 'object');
    assert.equal(Reflect.get(cursor, 'name'), String(index)); cursor = Reflect.get(cursor, 'child');
  }
  assert.deepEqual(cursor, { kind: 'done' });
});

test('successful saves do not reread view accessors after commit', async () => {
  let saved = false, reads = 0, saves = 0;
  const command = bindMutation({ workflow: workflow('decide', (amount: number) => ok({ amount })), operation: 'save',
    save: async () => { saved = true; saves++; return ok('stored'); },
    render: (value): View => {
      const child = command.Save({ value });
      return { kind: 'mutation', name: 'expense', get child() { reads++; if (saved) throw Error('late-view-read'); return child; } };
    },
  });
  assert.deepEqual(await command.runDetailed(5), { result: ok('stored'), trace: [
    { step: 'decide', status: 'ok' }, { step: 'save', status: 'ok' },
  ], plan: { kind: 'mutation', name: 'expense', child: { kind: 'write', operation: 'save', input: { amount: 5 } } } });
  assert.equal(saves, 1); assert.equal(reads, 1);
});

test('diagnostic plans describe the verified path before save changes view metadata', async () => {
  let wrapper: { kind: 'mutation'; name: string; child: View };
  const command = bindMutation({ workflow: workflow('decide', (amount: number) => ok({ amount })), operation: 'save',
    save: async () => { wrapper.name = 'after-save'; wrapper.child = { kind: 'done' }; return ok('stored'); },
    render: (value): View => (wrapper = { kind: 'mutation', name: 'before-save', child: command.Save({ value }) }),
  });
  const report = await command.runDetailed(5);
  assert.deepEqual(report.result, ok('stored'));
  assert.deepEqual(report.plan, { kind: 'mutation', name: 'before-save', child: { kind: 'write', operation: 'save', input: { amount: 5 } } });
});

test('cycle rejection finishes in an isolated process before invoking save', () => {
  const source = `import { bindMutation, workflow, ok } from './framework/index.js';
    let saves = 0;
    const node = { kind: 'mutation', name: 'cycle', child: { kind: 'done' } }; node.child = node;
    const command = bindMutation({ workflow: workflow('decide', n => ok(n)), operation: 'save',
      save: async value => { saves++; return ok(value); }, render: () => node });
    try { await command.run(5); process.exitCode = 2; }
    catch (error) { if (error.message !== 'CyclicView' || saves !== 0) process.exitCode = 3; else console.log('cycle rejected before save'); }
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cycle rejected before save/);
});
