// Development business API tested from the actual packed package.
import { business } from 'koyuki';
import { type GroupExecution, replayOperations, defineApplication } from 'koyuki';
import { validateSubmission, requireDays, submit, validateApproval, approve, validateWithdrawal, withdraw, balance,
  type Input, type SubmitInput, type Actor, type Account, type Change } from './domain.js';
import type { LeaveRepository, Operation, Request } from './repository.js';
export interface Call<I extends Input> { readonly requestId: string; readonly input: I }
export function leaveCommands(repository: LeaveRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor });
  const request = <I extends Input>(operation: Operation, call: Call<I>): Request => ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  return business({
    name: 'leave-study',
    operation: (name: Operation) => `leave.${name}.v1`,
    load: (call: Call<Input>) => repository.load(call.input, identity),
    save: (change: Change, execution: GroupExecution<Operation, Call<Input>>) => repository.save(request(execution.name, execution.request), change),
    replay: {
      lookup: (execution: GroupExecution<Operation, Call<Input>>) => repository.receipt(request(execution.name, execution.request)),
      resolveAfter: ['Conflict', 'InvalidState', 'StorageUnavailable'],
    },
    operations: {
      submit: { load: (call: Call<SubmitInput>) => repository.load(call.input, identity), run: [validateSubmission, requireDays, submit] },
      approve: [validateApproval, approve],
      withdraw: [validateWithdrawal, withdraw],
    },
  });
}
export function leaveApplication(repository: LeaveRepository, actor: Actor, initial: Account) {
  const commands = leaveCommands(repository, actor);
  return defineApplication({ initial: () => initial,
    operations: replayOperations(commands, (_before: Account, after: Account) => after),
    view: state => ({ account: state.data, balance: balance(state.data), busy: state.kind === 'running', error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}
