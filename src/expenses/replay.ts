import { defineTarget, withReplay, replayOperation, defineApplication, type Result, type Execution } from '../framework/index.js';
import { submitted, approved, rejected } from './application.js';
import type { Actor, Input, RejectInput, Loaded, Change, ExpenseState } from './domain.js';
import type { LoadError } from './repository.js';
import { type ExpenseReplayRepository, type ExpenseOperation, type ExpenseRequest } from './sqlite-replay.js';
export interface RequestInput<I> { readonly requestId: string; readonly input: I }
export function expenseReplayCommands(repository: ExpenseReplayRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor });
  const request = <I extends Input>(operation: ExpenseOperation, call: RequestInput<I>): ExpenseRequest =>
    ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  function target<I extends Input>(operation: ExpenseOperation, call: RequestInput<I>, load: (input: I) => Promise<Result<Loaded<I>, LoadError>>) {
    return defineTarget({ operation: `expense.${operation}.v1`, load,
      save: (change: Change) => repository.saveRequest(request(operation, call), change) });
  }
  function replay<I extends Input, E extends { kind: string }>(operation: ExpenseOperation, run: (input: RequestInput<I>) => Promise<Result<Execution<ExpenseState>, E>>) {
    return withReplay({ run }, {
      lookup: call => repository.receipt(request(operation, call)),
      resolveAfter: error => error.kind === 'SaveConflict' || error.kind === 'InvalidState' || error.kind === 'RepositoryUnavailable',
    });
  }
  return {
    submit: replay('submit', (call: RequestInput<Input>) => target('submit', call, input => repository.load(input, identity)).on(submitted).run(call.input)),
    approve: replay('approve', (call: RequestInput<Input>) => target('approve', call, input => repository.load(input, identity)).on(approved).run(call.input)),
    reject: replay('reject', (call: RequestInput<RejectInput>) => target('reject', call, input => repository.loadReject(input, identity)).on(rejected).run(call.input)),
  };
}
export function expenseReplayApplication(repository: ExpenseReplayRepository, actor: Actor, initial: readonly ExpenseState[]) {
  const commands = expenseReplayCommands(repository, actor);
  const replace = (state: readonly ExpenseState[], expense: ExpenseState) => state.map(current => current.id === expense.id ? expense : current);
  return defineApplication({ initial: () => initial,
    operations: { submit: replayOperation(commands.submit, replace), approve: replayOperation(commands.approve, replace), reject: replayOperation(commands.reject, replace) },
    view: state => ({ expenses: state.data, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error.kind : null }),
  });
}
