import type { Execution, ProgramTrace, Result, ReplayInputError } from '../../framework/index.js';
import { baselineReplay } from './baseline-replay.js';
import { applyCommitted } from './projection.js';
import type { procurementReplayApplication } from './projection.js';
import type { ReplayRepository } from './replay.js';
import type { Committed } from './application.js';
import type { Actor, Entity, Policy, RuleError } from './domain.js';
import type { StorageError } from './repository.js';
import type { ReplayError } from './replay-identity.js';
type Application = ReturnType<typeof procurementReplayApplication>;
type Session = Awaited<ReturnType<Application['start']>>;
type Snapshot = ReturnType<Session['snapshot']>;
type State = Snapshot['state'];
type Event = Parameters<Session['dispatch']>[0];
type Failure = RuleError | StorageError | ReplayError | ReplayInputError;
type Command = (input: unknown) => Promise<Result<Execution<Committed>, Failure>>;
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const rejected = <const K extends 'UnexpectedMessage' | 'StaleRevision'>(kind: K): Result<never, { kind: K }> => ({ ok: false, error: { kind } });
function unexpected(cause: unknown) {
  try { return { kind: 'UnexpectedException' as const, message: cause instanceof Error ? String(cause.message) : typeof cause === 'string' ? cause : 'Operation threw an unexpected value' }; }
  catch { return { kind: 'UnexpectedException' as const, message: 'Operation threw an unexpected value' }; }
}
/** Independent, in-process session driver. No defineApplication/Program/replayOperations execution. */
export function baselineApplication(mode: 'plain' | 'helper', repository: ReplayRepository, identity: Actor, policy: Policy, initial: readonly Entity[] = []): Application {
  const actor = Object.freeze({ ...identity });
  if (initial.some(entity => entity.groupId !== actor.groupId)) throw new Error('ProjectionScopeMismatch');
  const seed = structuredClone(initial), tables = baselineReplay(mode, repository, actor, policy);
  const names = { requests: 'request', orders: 'order', receipts: 'receipt', invoices: 'invoice', payments: 'payment', inventory: 'inventory' } as const;
  const commands = new Map<string, Command>();
  for (const group of Object.keys(names) as (keyof typeof tables)[]) for (const [key, command] of Object.entries(tables[group])) {
    commands.set(`${names[group]}.${key}`, command.run as unknown as Command);
  }
  const initialState = (): State => ({ kind: 'ready', data: { groupId: actor.groupId, entities: structuredClone(seed) } });
  const view = (state: State): Snapshot['view'] => ({ entities: state.data.entities, busy: state.kind === 'running', error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null });
  return {
    initial: initialState, view,
    async start(): Promise<Session> {
      let state = initialState(), revision = 0, tail: Promise<unknown> = Promise.resolve();
      const history: ProgramTrace[] = [], listeners = new Set<(snapshot: Snapshot) => void>();
      const snapshot = (): Snapshot => ({ revision, state: structuredClone(state), view: view(structuredClone(state)) });
      function publish() { for (const listener of listeners) { try { listener(snapshot()); } catch { /* accepted work continues */ } } }
      return {
        snapshot, trace: () => structuredClone(history),
        subscribe(listener) { listener(snapshot()); listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispatch(event: Event, expectedRevision?: number) {
          if (event.type !== 'dismiss' && !commands.has(event.type)) return Promise.resolve(rejected('UnexpectedMessage'));
          let received: Event;
          try { received = structuredClone(event.type === 'dismiss' ? { type: 'dismiss' } : { type: event.type, input: event.input }) as Event; }
          catch (cause) { return Promise.reject(cause); }
          const task = tail.then(async () => {
            if (expectedRevision !== undefined && expectedRevision !== revision) return rejected('StaleRevision');
            if (received.type === 'dismiss') {
              const accepted = state.kind === 'failed' || state.kind === 'crashed';
              history.push({ revision, kind: 'event', name: 'dismiss', status: accepted ? 'ok' : 'error' });
              if (!accepted) return rejected('UnexpectedMessage');
              state = { kind: 'ready', data: structuredClone(state.data) }; revision++; publish(); return ok(snapshot());
            }
            const operation = received.type;
            if (state.kind !== 'ready') { history.push({ revision, kind: 'event', name: '@execute', status: 'error' }); return rejected('UnexpectedMessage'); }
            history.push({ revision, kind: 'event', name: '@execute', status: 'ok' });
            state = { kind: 'running', operation, data: structuredClone(state.data) }; revision++; publish();
            let result: Result<Execution<Committed>, Failure> | null = null, crash: ReturnType<typeof unexpected> | null = null;
            try { result = await commands.get(operation)!(received.input); } catch (cause) { crash = unexpected(cause); }
            history.push({ revision, kind: 'command', name: operation, status: 'ok' });
            history.push({ revision, kind: 'event', name: crash ? '@crash' : '@complete', status: 'ok' });
            if (crash) state = { kind: 'crashed', operation, error: crash, data: state.data };
            else {
              if (!result) throw new Error('MissingBaselineExecutionResult');
              try {
                if (!result.ok) state = { kind: 'failed', operation, error: structuredClone(result.error), data: state.data };
                else state = { kind: 'ready', data: structuredClone(result.value.kind === 'replayed' ? state.data : applyCommitted(structuredClone(state.data), result.value.value)) };
              } catch (cause) { state = { kind: 'crashed', operation, error: unexpected(cause), data: state.data }; }
            }
            revision++; publish(); return ok(snapshot());
          });
          tail = task.catch(() => undefined);
          return task;
        },
      };
    },
  };
}
