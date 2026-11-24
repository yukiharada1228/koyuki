import test from 'node:test';
import assert from 'node:assert/strict';
import { replayOperations, replayOperation, defineApplication, ok, err, type Result, type Execution, type ApplicationEvent } from './framework/index.js';
const commands = {
  add: { run: async (n: number): Promise<Result<Execution<number>, 'Negative'>> => n < 0 ? err('Negative') : ok({ kind: 'committed', value: n }) },
  restore: { run: async (_id: string): Promise<Result<Execution<number>, 'Missing'>> => ok({ kind: 'replayed', value: 99 }) },
};
const reduce = (state: number, output: number) => state + output;
const operations = replayOperations(commands, reduce);
test('batch registration agrees with explicit registration for commit, replay and failure', async () => {
  const batch = await defineApplication({ initial: () => 10, operations, view: state => state }).start();
  const manual = await defineApplication({ initial: () => 10, operations: {
    add: replayOperation(commands.add, reduce), restore: replayOperation(commands.restore, reduce),
  }, view: state => state }).start();
  const events: ApplicationEvent<typeof operations>[] = [
    { type: 'add', input: 2 }, { type: 'restore', input: 'old' },
    { type: 'add', input: -1 }, { type: 'dismiss' },
  ];
  for (const event of events) {
    assert.deepEqual(await batch.dispatch(event), await manual.dispatch(event));
    assert.deepEqual(batch.snapshot(), manual.snapshot());
  }
  assert.equal(batch.snapshot().state.data, 12);
});
// Compile-time checks must preserve operation-specific inputs and errors.
const addError: Promise<Result<Execution<number>, 'Negative'>> = operations.add.run(1);
void addError;
if (false) {
  // @ts-expect-error add does not accept the restore input
  operations.add.run('id');
  // @ts-expect-error restore does not accept the add input
  operations.restore.run(1);
  // @ts-expect-error a reducer must accept every command's output
  replayOperations(commands, (state: number, output: string) => state + output.length);
  // @ts-expect-error plain success is not a replay execution envelope
  replayOperations({ plain: { run: async (_n: number) => ok(1) } }, reduce);
  // @ts-expect-error errors remain specific to the selected operation
  const wrong: Promise<Result<Execution<number>, 'Missing'>> = operations.add.run(1);
  void wrong;
}
