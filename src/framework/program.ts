import { snapshotData } from './snapshot.js';
import { ok, err, type Result } from './result.js';
import { executionSession, type ExecutionOptions, type ExecutionContext } from './execution.js';
export interface Command<M> { readonly name: string; readonly execute: () => Promise<M> }
export interface Update<S, M> { readonly state: S; readonly commands: readonly Command<M>[] }
export const next = <S, M = never>(state: S, ...commands: Command<M>[]): Update<S, M> => ({ state, commands });
/** Builds a command description. IO starts only when the runtime executes it. */
export function effect<I, O, M>(name: string, perform: (input: I) => Promise<O>, message: (output: O) => M) {
  return (input: I): Command<M> => ({ name, execute: async () => message(await perform(input)) });
}
export interface ProgramSnapshot<S, V> { readonly revision: number; readonly state: S; readonly view: V }
export interface ProgramTrace { readonly revision: number; readonly kind: 'event' | 'command'; readonly name: string; readonly status: 'ok' | 'error' }
/** One in-process Elm-style event loop. Not a durable job runner. */
export function defineProgram<S, M extends { type: string }, E, V>(definition: {
  init: () => Update<S, M>;
  update: (state: S, event: M) => Result<Update<S, M>, E>;
  view: (state: S) => V;
}) {
  return {
    init: definition.init, update: definition.update, view: definition.view,
    async start(options?: ExecutionOptions) {
      const executions = executionSession(options);
      const initialContext = executions.create('@init');
      initialContext?.emit({ kind: 'queued' }); initialContext?.emit({ kind: 'started' });
      const initialSpan = initialContext?.observe.scope?.('program.init');
      let initial: Update<S, M>;
      let state: S;
      try { initial = definition.init(); state = snapshotData(initial.state); initialSpan?.('ok'); }
      catch (cause) { initialSpan?.('defect'); initialContext?.emit({ kind: 'completed', status: 'defect' }); throw cause; }
      let revision = 0;
      const history: ProgramTrace[] = [];
      let tail: Promise<unknown> = Promise.resolve();
      const snapshot = (): ProgramSnapshot<S, V> => ({ revision, state: snapshotData(state), view: definition.view(snapshotData(state)) });
      function commit(value: S, name: string, context?: ExecutionContext): void {
        const finish = context?.observe.scope?.('program.accept');
        let owned: S;
        try { owned = snapshotData(value); }
        catch (cause) { finish?.('defect'); history.push({ revision, kind: 'event', name, status: 'error' }); throw cause; }
        history.push({ revision, kind: 'event', name, status: 'ok' });
        state = owned; revision++;
        finish?.('ok');
      }
      function update(message: M, context?: ExecutionContext) {
        const finish = context?.observe.scope?.(`program.update:${message.type}`);
        try { const result = definition.update(snapshotData(state), message); finish?.(result.ok ? 'ok' : 'error'); return result; }
        catch (cause) { finish?.('defect'); throw cause; }
      }
      async function settle(commands: readonly Command<M>[], context?: ExecutionContext): Promise<void> {
        const queue = [...commands];
        let count = 0;
        while (queue.length) {
          if (++count > 100) throw new Error('ProgramCommandLimit');
          const command = queue.shift()!;
          let message: M;
          const finish = context?.observe.scope?.(command.name);
          try { message = await command.execute(); finish?.('ok'); }
          catch (error) { finish?.('defect'); history.push({ revision, kind: 'command', name: command.name, status: 'error' }); throw error; }
          history.push({ revision, kind: 'command', name: command.name, status: 'ok' });
          const result = update(message, context);
          if (!result.ok) {
            history.push({ revision, kind: 'event', name: message.type, status: 'error' });
            throw new Error('RejectedCommandMessage', { cause: result.error });
          }
          commit(result.value.state, message.type, context);
          publish(); queue.push(...result.value.commands);
        }
      }
      const listeners = new Set<(value: ProgramSnapshot<S, V>) => void>();
      function publish() {
        for (const listener of listeners) {
          // Presentation failures must not interrupt an already accepted effect sequence.
          try { listener(snapshot()); } catch { /* observer owns its error reporting */ }
        }
      }
      try { await settle(initial.commands, initialContext); initialContext?.emit({ kind: 'completed', status: 'ok', revision }); }
      catch (cause) { initialContext?.emit({ kind: 'completed', status: 'defect', revision }); throw cause; }
      return {
        snapshot,
        trace: () => snapshotData(history),
        subscribeExecution: executions.subscribe,
        subscribe(listener: (value: ProgramSnapshot<S, V>) => void) {
          // Deliver the initial value before retaining a subscriber that may throw.
          listener(snapshot()); listeners.add(listener); return () => { listeners.delete(listener); };
        },
        dispatch(event: M, expectedRevision?: number): Promise<Result<ProgramSnapshot<S, V>, E | { kind: 'StaleRevision' }>> {
          // Take ownership at dispatch, before earlier commands release the queue.
          // Preserve the Promise rejection contract for non-cloneable events.
          let received: M;
          try { received = snapshotData(event); }
          catch (error) { return Promise.reject(error); }
          const context = executions.create(received.type);
          const task = tail.then(async () => {
            context?.emit({ kind: 'started' });
            const finish = context?.observe.scope?.('program.dispatch');
            try {
              if (expectedRevision !== undefined && expectedRevision !== revision) {
                finish?.('error'); context?.emit({ kind: 'completed', status: 'rejected', revision });
                return err({ kind: 'StaleRevision' as const });
              }
              const name = received.type;
              const result = update(received, context);
              if (!result.ok) {
                history.push({ revision, kind: 'event', name, status: 'error' });
                finish?.('error'); context?.emit({ kind: 'completed', status: 'error', revision }); return result;
              }
              commit(result.value.state, name, context);
              publish(); await settle(result.value.commands, context);
              const value = snapshot();
              finish?.('ok'); context?.emit({ kind: 'completed', status: 'ok', revision }); return ok(value);
            } catch (cause) { finish?.('defect'); context?.emit({ kind: 'completed', status: 'defect', revision }); throw cause; }
          });
          tail = task.catch(() => undefined);
          context?.emit({ kind: 'queued' });
          return task;
        },
      };
    },
  };
}
