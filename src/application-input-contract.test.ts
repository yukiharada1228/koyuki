import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApplication, operations, replayOperations, defineTransition, transition, step, ok, err, type Result, type Execution } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

test('dynamic command tables require input accepted by every branch and retain both error types', async () => {
  const left = { async run(input: { left: number }): Promise<Result<number, 'LeftError'>> { return input.left < 0 ? err('LeftError') : ok(input.left); } };
  const right = { async run(input: { right: string }): Promise<Result<number, 'RightError'>> { return input.right.length === 0 ? err('RightError') : ok(input.right.length); } };
  for (const command of [left, right]) {
    const app = defineApplication({ initial: () => 0, operations: operations({ go: command }, (_: number, n) => n), view: state => state.data });
    const session = await app.start();
    const result = await session.dispatch({ type: 'go', input: { left: 4, right: 'four' } }); assert(result.ok && result.value.state.data === 4);
    const failure = await session.dispatch({ type: 'go', input: { left: -1, right: '' } }); assert(failure.ok && failure.value.state.kind === 'failed');
    const errors: Equal<typeof failure.value.state.error, 'LeftError' | 'RightError'> = true; assert(errors);
    assert.equal(failure.value.state.error, command === left ? 'LeftError' : 'RightError');
    if (false) {
      // @ts-expect-error selected command may need right
      session.dispatch({ type: 'go', input: { left: 4 } });
      // @ts-expect-error selected command may need left
      session.dispatch({ type: 'go', input: { right: 'four' } });
    }
  }
});

test('raw Application operation unions have the same safe input contract', async () => {
  const left = { async run(input: { left: number }) { return ok(input.left); }, reduce: (_: number, value: number) => value };
  const right = { async run(input: { right: string }) { return ok(input.right.length); }, reduce: (_: number, value: number) => value };
  for (const go of [left, right]) {
    const app = defineApplication({ initial: () => 0, operations: { go }, view: state => state.data }), session = await app.start();
    const result = await session.dispatch({ type: 'go', input: { left: 4, right: 'four' } }); assert(result.ok && result.value.state.data === 4);
    if (false) {
      // @ts-expect-error raw operations cannot accept a request valid for only one branch
      session.dispatch({ type: 'go', input: { left: 4 } });
      // @ts-expect-error raw operations cannot accept a request valid for only one branch
      session.dispatch({ type: 'go', input: { right: 'four' } });
    }
  }
});

test('dynamic replay command tables keep the intersection of valid requests', async () => {
  const left = { async run(input: { left: number }): Promise<Result<Execution<number>, never>> { return ok({ kind: 'committed', value: input.left }); } };
  const right = { async run(input: { right: string }): Promise<Result<Execution<number>, never>> { return ok({ kind: 'committed', value: input.right.length }); } };
  for (const go of [left, right]) {
    const app = defineApplication({ initial: () => 0, operations: replayOperations({ go }, (_: number, n) => n), view: state => state.data }), session = await app.start();
    const result = await session.dispatch({ type: 'go', input: { left: 4, right: 'four' } }); assert(result.ok && result.value.state.data === 4);
    if (false) {
      // @ts-expect-error either replay command may be selected
      session.dispatch({ type: 'go', input: { left: 4 } });
      // @ts-expect-error either replay command may be selected
      session.dispatch({ type: 'go', input: { right: 'four' } });
    }
  }
});

test('one command accepting a union keeps that union, while disjoint selected commands have no valid request', async () => {
  const go = { async run(input: number | string) { return ok(typeof input === 'number' ? input : input.length); } };
  const app = defineApplication({ initial: () => 0, operations: operations({ go }, (_: number, n) => n), view: state => state.data }), session = await app.start();
  for (const input of [4, 'four']) { const result = await session.dispatch({ type: 'go', input }); assert(result.ok && result.value.state.data === 4); }
  if (false) {
    const numberOnly = { async run(input: number) { return ok(input.toFixed()); } };
    const stringOnly = { async run(input: string) { return ok(input.toUpperCase()); } };
    const selected = Date.now() > 0 ? numberOnly : stringOnly;
    const mixed = defineApplication({ initial: () => '', operations: operations({ go: selected }, (_: string, value) => value), view: state => state.data });
    const unsafe = await mixed.start();
    // @ts-expect-error no number is accepted by both selected commands
    unsafe.dispatch({ type: 'go', input: 4 });
    // @ts-expect-error no string is accepted by both selected commands
    unsafe.dispatch({ type: 'go', input: 'four' });
  }
});

test('the detail/run compatibility check also rejects unrelated error types', () => {
  if (false) {
    const wrong = { async run(n: number): Promise<Result<number, 'Business'>> { return ok(n); }, async runDetailed(n: number): Promise<{ result: Result<number, 'Other'>; trace: readonly []; plan: null }> { return { result: ok(n), trace: [], plan: null }; } };
    // @ts-expect-error observation cannot introduce errors outside the command contract
    operations({ go: wrong }, (_: number, value) => value);
  }
});

test('distinct operation keys retain distinct inputs instead of sharing one intersection', async () => {
  const commands = {
    left: { async run(input: { left: number }): Promise<Result<number, 'LeftError'>> { return ok(input.left); } },
    right: { async run(input: { right: string }): Promise<Result<number, 'RightError'>> { return ok(input.right.length); } },
  };
  const app = defineApplication({ initial: () => 0, operations: operations(commands, (_: number, n) => n), view: state => state.data }), session = await app.start();
  const first = await session.dispatch({ type: 'left', input: { left: 4 } }), second = await session.dispatch({ type: 'right', input: { right: 'four' } });
  assert(first.ok && second.ok); assert.equal(first.value.state.data, 4); assert.equal(second.value.state.data, 4);
  if (false) {
    // @ts-expect-error the right input is not accepted by the left operation
    session.dispatch({ type: 'left', input: { right: 'four' } });
    // @ts-expect-error the left input is not accepted by the right operation
    session.dispatch({ type: 'right', input: { left: 4 } });
  }
});


test('dynamic validation functions and named steps require an input accepted by all candidates', () => {
  const left = (input: { left: number }) => ok(input.left);
  const right = (input: { right: string }) => ok(input.right.length);
  for (const validate of [left, right, step('left', left), step('right', right)]) {
    const rule = transition(defineTransition({ validate, evolve: (n: number) => ok(n + 1) }));
    assert.deepEqual(rule.run({ left: 4, right: 'four' }), ok(5));
    if (false) {
      // @ts-expect-error either validation input may be required
      rule.run({ left: 4 });
      // @ts-expect-error either validation input may be required
      rule.run({ right: 'four' });
    }
  }
});

test('a single validator with union input keeps its accepted union', () => {
  const rule = transition(defineTransition({ validate: (input: number | string) => ok(typeof input === 'number' ? input : input.length), evolve: (n: number) => ok(n + 1) }));
  assert.deepEqual(rule.run(4), ok(5)); assert.deepEqual(rule.run('four'), ok(5));
});


test('callable validators use their call signature even when they carry rule metadata', () => {
  const validate = Object.assign((input: number) => ok(input), { rule: (_metadata: string) => ok(999) });
  const rule = transition(defineTransition({ validate, evolve: (n: number) => ok(n + 1) }));
  assert.deepEqual(rule.run(4), ok(5));
  if (false) {
    // @ts-expect-error metadata is not the validator actually invoked by the runtime
    rule.run('metadata');
  }
});
