// Development comparison; copied over application.ts in an isolated consumer.
import { defineUseCaseGroup, defineTransition, step, type GroupExecution, replayOperations, defineApplication } from 'koyuki';
import { validateSubmission, requireDays, submit, validateApproval, approve, validateWithdrawal, withdraw, balance,
  type Input, type SubmitInput, type Actor, type Account, type Change } from './domain.js';
import type { LeaveRepository, Operation, Request } from './repository.js';
export const submitted = defineTransition({ validate: validateSubmission, require: [step('require-days', requireDays)], evolve: submit });
export const approved = defineTransition({ validate: validateApproval, evolve: approve });
export const withdrawn = defineTransition({ validate: validateWithdrawal, evolve: withdraw });
export interface Call<I extends Input> { readonly requestId: string; readonly input: I }
export function leaveCommands(repository: LeaveRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor }); // trusted host identity, never chosen in the call
  const request = <I extends Input>(operation: Operation, call: Call<I>): Request => ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  const model = defineUseCaseGroup({
    operation: (name: Operation) => `leave.${name}.v1`,
    save: (change: Change, execution: GroupExecution<Operation, Call<Input>>) => repository.save(request(execution.name, execution.request), change),
    replay: {
      lookup: (execution: GroupExecution<Operation, Call<Input>>) => repository.receipt(request(execution.name, execution.request)),
      resolveAfter: ['Conflict', 'InvalidState', 'StorageUnavailable'],
    },
  });
  return {
    submit: model.on('submit', { load: (call: Call<SubmitInput>) => repository.load(call.input, identity), transition: submitted }),
    approve: model.on('approve', { load: (call: Call<Input>) => repository.load(call.input, identity), transition: approved }),
    withdraw: model.on('withdraw', { load: (call: Call<Input>) => repository.load(call.input, identity), transition: withdrawn }),
  };
}
export function leaveApplication(repository: LeaveRepository, actor: Actor, initial: Account) {
  const commands = leaveCommands(repository, actor);
  const replace = (_before: Account, after: Account) => after;
  return defineApplication({ initial: () => initial,
    operations: replayOperations(commands, replace),
    view: state => ({ account: state.data, balance: balance(state.data), busy: state.kind === 'running', error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}
