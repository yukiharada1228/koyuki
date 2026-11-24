import { defineRequestTarget, withReplay, replayOperation, defineApplication, type Result, type Execution } from '../framework/index.js';
import { submitted, approved, rejected, returned, edited } from './application.js';
import type { Actor, Input, RejectInput, EditInput, Loaded, Change, ExpenseState } from './domain.js';
import type { LoadError } from './repository.js';
import { type ExpenseReplayRepository, type ExpenseOperation, type ExpenseRequest } from './sqlite-replay.js';
export interface RequestInput<I> { readonly requestId: string; readonly input: I }
export function expenseReplayCommands(repository: ExpenseReplayRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor });
  const request = <I extends Input>(operation: ExpenseOperation, call: RequestInput<I>): ExpenseRequest =>
    ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  function target<I extends Input>(operation: ExpenseOperation, load: (input: I) => Promise<Result<Loaded<I>, LoadError>>) {
    return defineRequestTarget({ operation: `expense.${operation}.v1`,
      load: (call: RequestInput<I>) => load(call.input),
      save: (change: Change, execution) => repository.saveRequest(request(operation, execution.request), change) });
  }
  function replay<I extends Input, E extends { kind: string }>(operation: ExpenseOperation, command: { run(input: RequestInput<I>): Promise<Result<Execution<ExpenseState>, E>> }) {
    return withReplay(command, {
      lookup: call => repository.receipt(request(operation, call)),
      resolveAfter: error => error.kind === 'SaveConflict' || error.kind === 'InvalidState' || error.kind === 'RepositoryUnavailable',
    });
  }
  return {
    submit: replay('submit', target('submit', (input: Input) => repository.load(input, identity)).on(submitted)),
    approve: replay('approve', target('approve', (input: Input) => repository.load(input, identity)).on(approved)),
    return: replay('return', target('return', (input: RejectInput) => repository.load(input, identity)).on(returned)),
    edit: replay('edit', target('edit', (input: EditInput) => repository.load(input, identity)).on(edited)),
    reject: replay('reject', target('reject', (input: RejectInput) => repository.loadReject(input, identity)).on(rejected)),
  };
}
export function expenseReplayApplication(repository: ExpenseReplayRepository, actor: Actor, initial: readonly ExpenseState[]) {
  const commands = expenseReplayCommands(repository, actor);
  const replace = (state: readonly ExpenseState[], expense: ExpenseState) => state.map(current => current.id === expense.id ? expense : current);
  return defineApplication({ initial: () => initial,
    operations: { return: replayOperation(commands.return, replace), edit: replayOperation(commands.edit, replace), submit: replayOperation(commands.submit, replace), approve: replayOperation(commands.approve, replace), reject: replayOperation(commands.reject, replace) },
    view: state => ({ expenses: state.data, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error.kind : null }),
  });
}
