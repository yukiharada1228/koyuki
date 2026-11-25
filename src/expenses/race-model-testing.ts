import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AsyncSequenceModel, ModelStep } from '../framework/testing.js';
import { draftExpense, type Actor, type Input, type RejectInput } from './domain.js';
import { actors, reference, type Spec } from './model-testing.js';
import { initial, requestStep, type RequestEvent } from './request-model-testing.js';
import { ReplaySqliteExpenses } from './sqlite-replay.js';
import { expenseReplayCommands } from './replay.js';

export interface Race {
  readonly name: string; readonly sameId: boolean; readonly operation: 'approve' | 'reject';
  readonly actors: readonly [Actor, Actor]; readonly reasons: readonly [string, string];
  /** Test scheduling only, not a restriction on the oracle's allowed winners. */
  readonly first: 0 | 1;
}
type Outcome = ReturnType<typeof requestStep>['output'];
interface Allowed { outcomes: readonly Outcome[]; expense: Spec; receipts: number; changes: number }
const start = initial.find(state => state.start.amount === 100001 && state.start.receipt)!;
const seed: Extract<RequestEvent, { type: 'call' }> = {
  type: 'call', key: 0, stale: false,
  event: { type: 'submit', actor: actors[0]!, amount: 1, receipt: true, reason: '' },
};
const base = requestStep(start, seed).state;
function call(race: Race, side: 0 | 1): Extract<RequestEvent, { type: 'call' }> {
  return { type: 'call', key: race.sameId || side === 0 ? 1 : 2, stale: false,
    event: { type: race.operation, actor: race.actors[side], amount: 1, receipt: true, reason: race.reasons[side] } };
}

// Both validations see the original loaded state. Only successful decisions
// reach the receipt/CAS save boundary. Do not model the two commands as a pair
// of ordinary sequential HTTP requests with a second fresh load.
export function raceStep(round: number, race: Race): ModelStep<number, readonly Allowed[]> {
  const allowed = ([0, 1] as const).map(first => {
    let state = base;
    const outcomes: Outcome[] = [];
    for (const side of [first, first === 0 ? 1 : 0] as const) {
      const command = call(race, side), validation = reference(base.expense, command.event);
      if ('error' in validation) outcomes[side] = { kind: 'error', error: validation.error };
      else {
        const step = requestStep(state, { ...command, stale: state.expense.version !== base.expense.version });
        state = step.state; outcomes[side] = step.output;
      }
    }
    return { outcomes, expense: state.expense, receipts: state.receipts.length, changes: state.expense.version - 1 };
  });
  return { state: round + 1, output: allowed };
}

const boss = actors[1]!, other = actors[6]!, owner = actors[7]!, inactive = actors[3]!;
export const races: readonly Race[] = [
  { name: 'same-id-same-approval', sameId: true, operation: 'approve', actors: [boss, boss], reasons: ['', ''], first: 0 },
  { name: 'different-ids-same-approval', sameId: false, operation: 'approve', actors: [boss, boss], reasons: ['', ''], first: 0 },
  { name: 'same-id-different-reasons', sameId: true, operation: 'reject', actors: [boss, boss], reasons: ['first', 'second'], first: 0 },
  { name: 'different-ids-different-reasons', sameId: false, operation: 'reject', actors: [boss, boss], reasons: ['first', 'second'], first: 0 },
  { name: 'same-id-different-actors', sameId: true, operation: 'approve', actors: [boss, other], reasons: ['', ''], first: 0 },
  { name: 'different-ids-different-actors', sameId: false, operation: 'approve', actors: [boss, other], reasons: ['', ''], first: 0 },
  { name: 'self-approval-and-valid-approval', sameId: true, operation: 'approve', actors: [owner, boss], reasons: ['', ''], first: 0 },
  { name: 'inactive-and-valid-approval', sameId: true, operation: 'approve', actors: [inactive, boss], reasons: ['', ''], first: 0 },
  { name: 'both-forbidden', sameId: false, operation: 'approve', actors: [inactive, inactive], reasons: ['', ''], first: 0 },
  { name: 'missing-and-valid-reason', sameId: true, operation: 'reject', actors: [boss, boss], reasons: [' ', 'valid'], first: 0 },
];

export async function compareRace(race: Race, expected: readonly Allowed[]): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'koyuki-expense-model-race-')), path = join(dir, 'db.sqlite');
  const repositories: ReplaySqliteExpenses[] = [];
  let inspection: DatabaseSync | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const repository = new ReplaySqliteExpenses(path); repositories.push(repository);
    const draft = draftExpense({ id: start.start.id, owner: start.start.owner, amount: start.start.amount, receipt: start.start.receipt });
    assert(draft.ok); assert(repository.insertDraft(draft.value).ok);
    assert((await expenseReplayCommands(repository, actors[0]!).submit.run({ requestId: 'request-0', input: { id: draft.value.id, expectedVersion: 1 } })).ok);
    assert.deepEqual(repository.list(), { ok: true, value: [base.expense] });

    const releases: (() => void)[] = [], loaded: number[] = [];
    const gates = [0, 1].map(side => new Promise<void>(resolve => { releases[side] = resolve; }));
    let arrivals = 0, timedOut = false;
    timer = setTimeout(() => { timedOut = true; releases.forEach(release => release()); }, 5000);
    const arrive = async (side: 0 | 1, version: number) => {
      loaded[side] = version;
      if (++arrivals === 2) releases[race.first]!();
      await gates[side];
      if (timedOut) throw new Error('RaceLoadBarrierTimedOut');
    };
    class Reader extends ReplaySqliteExpenses {
      constructor(readonly side: 0 | 1) { super(path); }
      override async load<I extends Input>(input: I, actor: Actor) {
        const result = await super.load(input, actor);
        await arrive(this.side, result.ok ? result.value.current.version : -1); return result;
      }
      override async loadReject(input: RejectInput, actor: Actor) {
        const result = await super.loadReject(input, actor);
        await arrive(this.side, result.ok ? result.value.current.version : -1); return result;
      }
    }
    const run = async (side: 0 | 1): Promise<Outcome> => {
      const reader = new Reader(side); repositories.push(reader);
      try {
        const commands = expenseReplayCommands(reader, race.actors[side]);
        const command = call(race, side), requestId = `request-${command.key}`;
        const input = { id: base.expense.id, expectedVersion: base.expense.version };
        const result = race.operation === 'approve' ? await commands.approve.run({ requestId, input })
          : await commands.reject.run({ requestId, input: { ...input, reason: race.reasons[side] } });
        return result.ok ? { kind: result.value.kind, value: result.value.value } : { kind: 'error', error: result.error.kind };
      } finally { if (side === race.first) releases[side === 0 ? 1 : 0]!(); }
    };
    // Await both, including failures, before closing the connections or deleting files.
    const results = await Promise.allSettled([run(0), run(1)]);
    if (results.some(result => result.status === 'rejected')) throw new Error('RaceExecutionFailed', { cause: results });
    if (!isDeepStrictEqual(loaded, [2, 2])) return false;
    const outcomes = results.map(result => { assert(result.status === 'fulfilled'); return result.value; });
    inspection = new DatabaseSync(path);
    const receipts = Number(inspection.prepare('SELECT count(*) n FROM expense_receipts').get()?.n);
    const changes = Number(inspection.prepare('SELECT count(*) n FROM expense_changes').get()?.n);
    return expected.some(candidate => isDeepStrictEqual(outcomes, candidate.outcomes)
      && isDeepStrictEqual(repository.list(), { ok: true, value: [candidate.expense] })
      && receipts === candidate.receipts && changes === candidate.changes);
  } finally {
    if (timer) clearTimeout(timer);
    inspection?.close();
    for (const repository of repositories.reverse()) repository.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export const models = { 'expense-races-sqlite': {
  initial: [0], limits: { cases: 1, length: 12, shrinkAttempts: 64 },
  events: (_round: number, random: () => number) => races.map(race => ({ ...race, first: random() < 0.5 ? 0 as const : 1 as const })),
  step: raceStep,
  check: (_round: number, race: Race, expected: ModelStep<number, readonly Allowed[]>) => compareRace(race, expected.output),
} } satisfies Record<string, Omit<AsyncSequenceModel<number, Race, readonly Allowed[]>, 'seed'>>;
