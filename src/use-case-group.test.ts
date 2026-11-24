import test from 'node:test';
import assert from 'node:assert/strict';
import { defineUseCaseGroup, defineUseCase, step, ok, err, type Result, type Execution, type Receipt, type GroupExecution, type ActionReport } from './framework/index.js';
type Failure = { kind: 'Invalid' } | { kind: 'Conflict' };
const transition = {
  validate: step('positive', (n: number): Result<number, { kind: 'Invalid' }> => n > 0 ? ok(n) : err({ kind: 'Invalid' })),
  require: [step('limit', (n: number): Result<number, { kind: 'Limit' }> => n <= 10 ? ok(n) : err({ kind: 'Limit' }))] as const,
  evolve: step('double', (n: number) => ok(n * 2)),
};
test('group agrees with individual use cases for commit, replay, validation, requirement, lookup and recovery', async () => {
  for (const scenario of ['commit', 'hit', 'deny', 'limit', 'recover', 'missing', 'lookup-error', 'save-replay'] as const) {
    function compose(grouped: boolean) {
      let lookups = 0, writes = 0;
      const saved: GroupExecution<'add', number>[] = [];
      const save = async (n: number, execution: GroupExecution<'add', number>): Promise<Result<Execution<number>, { kind: 'Conflict' }>> => {
        writes++; saved.push(execution);
        if (scenario === 'recover' || scenario === 'missing') return err({ kind: 'Conflict' });
        return ok({ kind: scenario === 'save-replay' ? 'replayed' : 'committed', value: n });
      };
      const lookup = (execution: GroupExecution<'add', number>): Result<Receipt<number>, { kind: 'Unavailable' }> => {
        assert.deepEqual(execution, { name: 'add', operation: 'number.add.v1', request: scenario === 'deny' ? -1 : scenario === 'limit' ? 11 : 2 });
        lookups++;
        return scenario === 'lookup-error' ? err({ kind: 'Unavailable' }) : scenario === 'hit' || (scenario === 'recover' && lookups === 2)
          ? ok({ kind: 'found', value: 4 }) : ok({ kind: 'missing' });
      };
      const command = grouped ? defineUseCaseGroup({ operation: (_name: 'add') => 'number.add.v1', save,
        replay: { lookup, resolveAfter: ['Conflict'] },
      }).on('add', { load: async (n: number) => ok(n), transition })
        : defineUseCase({ operation: 'number.add.v1', load: async (n: number) => ok(n), transition,
          save: (n: number, execution: { request: number }) => save(n, { ...execution, operation: 'number.add.v1', name: 'add' }),
          replay: { lookup: (n: number) => lookup({ name: 'add', operation: 'number.add.v1', request: n }), resolveAfter: (e: unknown) => typeof e === 'object' && e !== null && 'kind' in e && e.kind === 'Conflict' },
        });
      return { command, observations: () => ({ lookups, writes, saved }) };
    }
    const grouped = compose(true), individual = compose(false), input = scenario === 'deny' ? -1 : scenario === 'limit' ? 11 : 2;
    assert.deepEqual(await grouped.command.runDetailed(input), await individual.command.runDetailed(input), scenario);
    assert.deepEqual(grouped.observations(), individual.observations(), scenario);
  }
});
test('plain group preserves context across concurrent operations and exposes thrown adapter failures', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const saved: GroupExecution<'slow' | 'fast', number>[] = [];
  const model = defineUseCaseGroup({ operation: (name: 'slow' | 'fast') => `number.${name}.v1`,
    save: async (value: number, execution: GroupExecution<'slow' | 'fast', number>) => { saved.push(execution); return ok(value); },
  });
  const slow = model.on('slow', { load: async (n: number) => { await gate; return ok(n); }, transition });
  const fast = model.on('fast', { load: async (n: number) => ok(n), transition });
  const first = slow.run(1); assert.deepEqual(await fast.run(2), ok(4)); release(); assert.deepEqual(await first, ok(2));
  assert.deepEqual(saved.map(e => [e.name, e.operation, e.request]), [['fast', 'number.fast.v1', 2], ['slow', 'number.slow.v1', 1]]);
  assert.ok(saved.every(Object.isFrozen));
  const broken = model.on('fast', { load: async (_n: number): Promise<Result<number, never>> => { throw new Error('adapter bug'); }, transition });
  await assert.rejects(broken.run(1), /adapter bug/);
});
test('recovery policy safely handles non-object errors and captures its tag configuration', async () => {
  const tags = ['Conflict']; let calls = 0;
  const model = defineUseCaseGroup({ operation: (_name: 'add') => 'number',
    save: async (_n: number, _e: GroupExecution<'add', number>): Promise<Result<Execution<number>, string>> => err('Conflict'),
    replay: { lookup: () => { calls++; return ok({ kind: 'missing' as const }); }, resolveAfter: tags },
  });
  tags.push('Invalid');
  const command = model.on('add', { load: async (n: number) => ok(n), transition });
  assert.deepEqual(await command.run(1), err('Conflict')); assert.equal(calls, 1);
  assert.deepEqual(await command.run(-1), err({ kind: 'Invalid' })); assert.equal(calls, 2);
});
function typeContracts() {
  const model = defineUseCaseGroup({ operation: (name: 'add' | 'other') => name,
    save: async (n: number, _context: GroupExecution<'add' | 'other', number>) => ok(n),
  });
  const command = model.on('add', { load: async (n: number) => ok(n), transition });
  const exact: Promise<Result<number, { kind: 'Invalid' } | { kind: 'Limit' }>> = command.run(1); void exact;
  const detailed: Promise<ActionReport<number, { kind: 'Invalid' } | { kind: 'Limit' }>> = command.runDetailed(1); void detailed;
  // @ts-expect-error names are constrained by the adapter's declared business operations
  model.on('unknown', { load: async (n: number) => ok(n), transition });
  // @ts-expect-error load must preserve the shared request contract
  model.on('add', { load: async (n: string) => ok(n.length), transition });
  // @ts-expect-error the loaded context must match validate
  model.on('add', { load: async (n: number) => ok(String(n)), transition });
  // @ts-expect-error evolve must produce the shared save input
  model.on('add', { load: async (n: number) => ok(n), transition: { ...transition, evolve: step('bad', (n: number) => ok(String(n))) } });
  // @ts-expect-error require adjacency cannot be bypassed by the group
  model.on('add', { load: async (n: number) => ok(n), transition: { ...transition, require: [step('bad', (s: string) => ok(s))] as const } });
  // @ts-expect-error a replay group cannot save an unwrapped business output
  defineUseCaseGroup({ operation: (_name: 'add') => 'add', save: async (n: number, _e: GroupExecution<'add', number>) => ok(n), replay: { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: [] } });
  const replay = defineUseCaseGroup({ operation: (_name: 'add') => 'add',
    save: async (n: number, _e: GroupExecution<'add', number>): Promise<Result<Execution<number>, { kind: 'Conflict' }>> => ok({ kind: 'committed', value: n }),
    replay: { lookup: (context): Result<Receipt<number>, { kind: 'Unavailable' }> => {
      const n: number = context.request; void n;
      // @ts-expect-error request context must not widen to any
      context.request.wrong;
      return ok({ kind: 'missing' });
    }, resolveAfter: error => {
      // @ts-expect-error shared recovery sees unknown because errors differ between operations
      error.kind;
      return false;
    } },
  });
  const replayed = replay.on('add', { load: async (n: number) => ok(n), transition });
  const typed: Promise<Result<Execution<number>, Failure | { kind: 'Limit' } | { kind: 'Unavailable' } | { kind: 'ReplayInputNotCloneable' }>> = replayed.run(1); void typed;
  // @ts-expect-error group lookup must return the saved business output
  defineUseCaseGroup({ operation: (_name: 'add') => 'add', save: async (n: number, _e: GroupExecution<'add', number>) => ok({ kind: 'committed' as const, value: n }), replay: { lookup: () => ok({ kind: 'found' as const, value: 'bad' }), resolveAfter: [] } });
}
void typeContracts;
