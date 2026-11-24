import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineRequestTarget, step, ok, err } from './framework/index.js';

type Request = { id: string; amount: number };
const behavior = {
  validate: step('positive', (amount: number) => amount > 0 ? ok(amount) : err({ kind: 'InvalidAmount' } as const)),
  require: [] as const,
  evolve: step('double', (amount: number) => ok(amount * 2)),
};

test('interleaved requests retain their own metadata and detailed trace', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: { id: string; value: number; operation: string }[] = [];
  const command = defineRequestTarget({
    operation: 'charge.v1',
    load: async (request: Request) => {
      if (request.id === 'first') await gate;
      return ok(request.amount);
    },
    save: async (value: number, execution) => {
      writes.push({ id: execution.request.id, value, operation: execution.operation });
      return ok(value);
    },
  }).on(behavior);
  const first = command.run({ id: 'first', amount: 2 });
  const second = await command.runDetailed({ id: 'second', amount: 3 });
  release();
  assert.deepEqual(await first, ok(4));
  assert.deepEqual(second.result, ok(6));
  assert.deepEqual(writes, [
    { id: 'second', value: 6, operation: 'charge.v1' },
    { id: 'first', value: 4, operation: 'charge.v1' },
  ]);
  assert.deepEqual(second.trace.map(entry => entry.step), ['charge.v1:load', 'positive', 'double', 'charge.v1']);
  assert.ok(second.plan);
  if (false) {
    // @ts-expect-error request-bound saving cannot bypass its request boundary
    command.mutation.run(2);
    // @ts-expect-error request metadata remains typed
    command.run({ id: 1, amount: 2 });
  }
});

test('load and domain failures stop before saving, save failures remain typed results', async () => {
  let saves = 0;
  const command = defineRequestTarget({
    operation: 'charge.v1',
    load: async (request: Request) => request.id === 'missing' ? err({ kind: 'Missing' } as const) : ok(request.amount),
    save: async (_value: number, _execution) => { saves++; return err({ kind: 'Conflict' } as const); },
  }).on(behavior);
  assert.deepEqual(await command.run({ id: 'missing', amount: 2 }), err({ kind: 'Missing' }));
  assert.deepEqual(await command.run({ id: 'invalid', amount: 0 }), err({ kind: 'InvalidAmount' }));
  assert.equal(saves, 0);
  assert.deepEqual(await command.run({ id: 'valid', amount: 2 }), err({ kind: 'Conflict' }));
  assert.equal(saves, 1);
});
