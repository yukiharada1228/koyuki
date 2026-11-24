import { ok, err, type Result } from './result.js';
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
    async start() {
      const initial = definition.init();
      let state = structuredClone(initial.state), revision = 0;
      const history: ProgramTrace[] = [];
      let tail: Promise<unknown> = Promise.resolve();
      const snapshot = (): ProgramSnapshot<S, V> => ({ revision, state: structuredClone(state), view: definition.view(structuredClone(state)) });
      async function settle(commands: readonly Command<M>[]): Promise<void> {
        const queue = [...commands];
        let count = 0;
        while (queue.length) {
          if (++count > 100) throw new Error('ProgramCommandLimit');
          const command = queue.shift()!;
          let message: M;
          try { message = await command.execute(); }
          catch (error) { history.push({ revision, kind: 'command', name: command.name, status: 'error' }); throw error; }
          history.push({ revision, kind: 'command', name: command.name, status: 'ok' });
          const result = definition.update(structuredClone(state), message);
          history.push({ revision, kind: 'event', name: message.type, status: result.ok ? 'ok' : 'error' });
          if (!result.ok) throw new Error('RejectedCommandMessage', { cause: result.error });
          state = structuredClone(result.value.state); revision++;
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
      await settle(initial.commands);
      return {
        snapshot,
        trace: () => structuredClone(history),
        subscribe(listener: (value: ProgramSnapshot<S, V>) => void) {
          listeners.add(listener); listener(snapshot()); return () => { listeners.delete(listener); };
        },
        dispatch(event: M, expectedRevision?: number): Promise<Result<ProgramSnapshot<S, V>, E | { kind: 'StaleRevision' }>> {
          const task = tail.then(async () => {
            if (expectedRevision !== undefined && expectedRevision !== revision) return err({ kind: 'StaleRevision' as const });
            const result = definition.update(structuredClone(state), structuredClone(event));
            history.push({ revision, kind: 'event', name: event.type, status: result.ok ? 'ok' : 'error' });
            if (!result.ok) return result;
            state = structuredClone(result.value.state); revision++;
            publish(); await settle(result.value.commands); return ok(snapshot());
          });
          tail = task.catch(() => undefined);
          return task;
        },
      };
    },
  };
}
