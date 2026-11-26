import test from 'node:test';
import assert from 'node:assert/strict';
import { bindMutation, workflow, ok } from './framework/index.js';
type View = ReturnType<ReturnType<typeof bindMutation>['view']>;

for (const timing of ['before-save-node', 'after-save-node', 'restore-after-save-node']) test(`an explicit renderer cannot mutate the original decision: ${timing}`, async () => {
  let saves = 0;
  const command = bindMutation({ workflow: workflow('decide', (amount: number) => ok({ amount })), operation: 'save',
    save: async (value: { amount: number }) => { saves++; return ok(value); },
    render: (value): View => {
      if (timing === 'after-save-node') {
        const node = command.Save({ value }); value.amount = 999; return node;
      }
      value.amount = 999;
      const node = command.Save({ value });
      if (timing === 'restore-after-save-node') value.amount = 5;
      return node;
    },
  });
  await assert.rejects(command.run(5), /ChangedDecision/);
  assert.equal(saves, 0);
});

test('lossy JSON identities are rejected without invoking the explicit renderer', async () => {
  const hidden = Object.defineProperty({ amount: 5 }, 'proof', { value: true });
  const symbolic = Object.assign([1], { [Symbol('proof')]: true });
  const sparse = Array(1);
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  class DomainArray extends Array<number> {}
  for (const value of [hidden, symbolic, sparse, cyclic, new DomainArray(1), -0, { amount: -0 }]) {
    let renders = 0, saves = 0;
    const command = bindMutation({ workflow: workflow('decide', (value: unknown) => ok(value)), operation: 'save',
      save: async (value: unknown) => { saves++; return ok(value); },
      render: (value): View => { renders++; return command.Save({ value }); },
    });
    await assert.rejects(command.run(value));
    assert.equal(renders, 0); assert.equal(saves, 0);
  }
});

test('plain data with reordered keys, shared values and null prototypes still binds once', async () => {
  const shared = { amount: 5 };
  const value = Object.assign(Object.create(null), { right: shared, left: shared, zero: 0 });
  let saves = 0;
  const command = bindMutation({ workflow: workflow('decide', (value: unknown) => ok(value)), operation: 'save',
    save: async (saved: unknown) => { saves++; assert.deepEqual(saved, { zero: 0, left: shared, right: shared }); return ok('saved'); },
    render: (): View => command.Save({ value: { zero: 0, left: shared, right: shared } }),
  });
  assert.deepEqual(await command.run(value), ok('saved')); assert.equal(saves, 1);
});

test('array metadata cannot be substituted through JSON identity loss', async () => {
  let saves = 0;
  const command = bindMutation({ workflow: workflow('decide', (total: number) => ok(Object.assign([1], { total }))), operation: 'save',
    save: async (value: number[] & { total: number }) => { saves++; return ok(value); },
    render: (): View => command.Save({ value: Object.assign([1], { total: 999 }) }),
  });
  await assert.rejects(command.run(5), /NonSerializableInput/);
  assert.equal(saves, 0);
});

test('decision accessors are rejected before a renderer or getter can run', async () => {
  let getters = 0, renders = 0, saves = 0;
  const command = bindMutation({ workflow: workflow('decide', () => ok({ get amount() { getters++; return 5; } })), operation: 'save',
    save: async (value: { amount: number }) => { saves++; return ok(value); },
    render: (value): View => { renders++; return command.Save({ value }); },
  });
  await assert.rejects(command.run(undefined), /NonSerializableInput/);
  assert.equal(getters, 0); assert.equal(renders, 0); assert.equal(saves, 0);
});
