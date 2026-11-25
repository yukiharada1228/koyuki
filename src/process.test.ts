import test from 'node:test';
import assert from 'node:assert/strict';
import { process, workflow, ok, err, defineApplication, operation, type Result, type ActionReport } from './framework/index.js';

test('an effect process executes directly with exact results, traces and no invented mutation plan', async () => {
  const calls: string[] = [];
  const command = process<number>()
    .effect('read', async (id): Promise<Result<string, 'Unavailable'>> => { calls.push('read'); return ok(String(id)); })
    .through(workflow('validate', (text: string): Result<number, 'Invalid'> => ok(Number(text))))
    .effect('publish', async (value): Promise<Result<boolean, 'Rejected'>> => { calls.push('publish'); return ok(value === 2); });
  assert.deepEqual(calls, []);
  const { run, runDetailed } = command;
  const report: ActionReport<boolean, 'Unavailable' | 'Invalid' | 'Rejected'> = await runDetailed(2);
  assert.deepEqual(report, { result: ok(true), trace: ['read', 'validate', 'publish'].map(step => ({ step, status: 'ok' })), plan: null });
  const result: Result<boolean, 'Unavailable' | 'Invalid' | 'Rejected'> = await run(3);
  assert.deepEqual(result, ok(false)); assert.deepEqual(calls, ['read', 'publish', 'read', 'publish']);
});

test('direct process execution stops at both IO and pure failures without running later effects', async () => {
  for (const failing of ['read', 'validate', 'publish'] as const) {
    const calls: string[] = [];
    const command = process<number>()
      .effect('read', async n => { calls.push('read'); return failing === 'read' ? err('Unavailable' as const) : ok(n); })
      .through(workflow('validate', (n: number) => { calls.push('validate'); return failing === 'validate' ? err('Invalid' as const) : ok(n); }))
      .effect('publish', async n => { calls.push('publish'); return err('Rejected' as const); })
      .effect('later', async () => { assert.fail('must stop at first error'); });
    const report = await command.runDetailed(2);
    assert.deepEqual(report.result, err(failing === 'read' ? 'Unavailable' : failing === 'validate' ? 'Invalid' : 'Rejected'));
    assert.equal(report.trace.at(-1)?.step, failing); assert.equal(report.trace.at(-1)?.status, 'error');
    assert.deepEqual(report.trace.map(entry => entry.step), calls); assert.equal(report.plan, null);
  }
});

test('direct process runs keep concurrent invocation values separate', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command = process<number>().effect('wait', async n => { if (n === 1) await gate; return ok(n); })
    .effect('double', async n => ok(n * 2));
  const slow = command.run(1);
  assert.deepEqual(await command.run(2), ok(4)); release(); assert.deepEqual(await slow, ok(2));
});

test('direct process execution preserves rejected and thrown defects instead of treating them as Result errors', async () => {
  const defect = new Error('SDK defect');
  for (const perform of [() => { throw defect; }, () => Promise.reject(defect)]) {
    const command = process<number>().effect('broken', perform).effect('later', async () => { assert.fail('must not run'); });
    await assert.rejects(command.run(1), error => error === defect);
    await assert.rejects(command.runDetailed(1), error => error === defect);
  }
});

test('Application can execute an effect-only command and project success or preserve state on failure', async () => {
  const delivery = process<number>().effect('send', async id => id > 0 ? ok(`sent:${id}`) : err('InvalidId' as const));
  const initial: readonly string[] = [];
  const app = await defineApplication({ initial: () => initial,
    operations: { deliver: operation(delivery, (before: readonly string[], after: string) => [...before, after]) },
    view: state => ({ messages: state.data, kind: state.kind }),
  }).start();
  assert((await app.dispatch({ type: 'deliver', input: 1 })).ok);
  assert.deepEqual(app.snapshot().view, { messages: ['sent:1'], kind: 'ready' });
  assert((await app.dispatch({ type: 'deliver', input: 0 })).ok);
  assert.deepEqual(app.snapshot().view, { messages: ['sent:1'], kind: 'failed' });
});

function contracts() {
  const command = process<number>().effect('stringify', async n => ok(String(n)));
  const exact: Promise<Result<string, never>> = command.run(1); void exact;
  // @ts-expect-error direct execution preserves the original input type
  command.run('one');
  // @ts-expect-error direct execution preserves the final output type
  const wrong: Promise<Result<number, never>> = command.run(1); void wrong;
  // @ts-expect-error IO stages must accept the preceding successful value
  command.effect('bad', async (n: number) => ok(n));
}
void contracts;
