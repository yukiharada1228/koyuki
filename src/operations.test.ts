import test from 'node:test';
import assert from 'node:assert/strict';
import { operations, operation, defineApplication, ok, err, type Result, type ApplicationEvent } from './framework/index.js';
const commands = {
  add: { run: async (n: number): Promise<Result<number, 'Negative'>> => n < 0 ? err('Negative') : ok(n) },
  parse: { run: async (text: string): Promise<Result<number, 'Invalid'>> => Number.isNaN(Number(text)) ? err('Invalid') : ok(Number(text)) },
};
const reduce = (state: number, output: number) => state + output;
const registered = operations(commands, reduce);
test('plain command table preserves independent signatures and agrees with individual registration', async () => {
  const batch = await defineApplication({ initial: () => 1, operations: registered, view: state => state }).start();
  const manual = await defineApplication({ initial: () => 1, operations: { add: operation(commands.add, reduce), parse: operation(commands.parse, reduce) }, view: state => state }).start();
  const events: ApplicationEvent<typeof registered>[] = [{ type: 'add', input: 2 }, { type: 'parse', input: '3' }, { type: 'parse', input: '?' }, { type: 'dismiss' }];
  for (const event of events) {
    assert.deepEqual(await batch.dispatch(event), await manual.dispatch(event));
    assert.deepEqual(batch.snapshot(), manual.snapshot());
  }
  assert.equal(batch.snapshot().state.data, 6);
});
function typeContracts() {
  const exact: Promise<Result<number, 'Negative'>> = registered.add.run(1); void exact;
  // @ts-expect-error add retains its own input type
  registered.add.run('1');
  // @ts-expect-error failures do not widen to another operation's failure
  const wrong: Promise<Result<number, 'Negative'>> = registered.parse.run('1'); void wrong;
  // @ts-expect-error the projection must accept every success value
  operations({ text: { run: async (_s: string) => ok('text') }, ...commands }, reduce);
}
void typeContracts;
