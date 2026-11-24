import { defineUseCaseGroup, replayOperations, defineApplication, type GroupExecution } from '../framework/index.js';
import { submitted, approved, rejected, returned, edited } from './application.js';
import type { Actor, Input, RejectInput, EditInput, Change, ExpenseState } from './domain.js';
import { type ExpenseReplayRepository, type ExpenseOperation, type ExpenseRequest } from './sqlite-replay.js';
export interface RequestInput<I> { readonly requestId: string; readonly input: I }
export function expenseReplayCommands(repository: ExpenseReplayRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor });
  const request = <I extends Input>(operation: ExpenseOperation, call: RequestInput<I>): ExpenseRequest =>
    ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  const model = defineUseCaseGroup({
    operation: (name: ExpenseOperation) => `expense.${name}.v1`,
    save: (change: Change, execution: GroupExecution<ExpenseOperation, RequestInput<Input>>) => repository.saveRequest(request(execution.name, execution.request), change),
    replay: {
      lookup: (execution: GroupExecution<ExpenseOperation, RequestInput<Input>>) => repository.receipt(request(execution.name, execution.request)),
      resolveAfter: ['SaveConflict', 'InvalidState', 'RepositoryUnavailable'],
    },
  });
  return {
    submit: model.on('submit', { load: (call: RequestInput<Input>) => repository.load(call.input, identity), transition: submitted }),
    approve: model.on('approve', { load: (call: RequestInput<Input>) => repository.load(call.input, identity), transition: approved }),
    return: model.on('return', { load: (call: RequestInput<RejectInput>) => repository.load(call.input, identity), transition: returned }),
    edit: model.on('edit', { load: (call: RequestInput<EditInput>) => repository.load(call.input, identity), transition: edited }),
    reject: model.on('reject', { load: (call: RequestInput<RejectInput>) => repository.loadReject(call.input, identity), transition: rejected }),
  };
}
export function expenseReplayApplication(repository: ExpenseReplayRepository, actor: Actor, initial: readonly ExpenseState[]) {
  const commands = expenseReplayCommands(repository, actor);
  const replace = (state: readonly ExpenseState[], expense: ExpenseState) => state.map(current => current.id === expense.id ? expense : current);
  return defineApplication({ initial: () => initial,
    operations: replayOperations(commands, replace),
    view: state => ({ expenses: state.data, busy: state.kind === 'running', error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}
