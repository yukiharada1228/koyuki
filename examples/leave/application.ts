import { defineRequestTarget, step, withReplay, replayOperation, defineApplication } from 'koyuki';
import { validateSubmission, requireDays, submit, validateApproval, approve, validateWithdrawal, withdraw, balance,
  type Input, type SubmitInput, type Actor, type Account, type Change } from './domain.js';
import type { LeaveRepository, Operation, Request } from './repository.js';
export const submitted = { validate: step('authorize-submit', validateSubmission), require: [step('require-days', requireDays)] as const, evolve: step('submit', submit) };
export const approved = { validate: step('authorize-approval', validateApproval), require: [] as const, evolve: step('approve', approve) };
export const withdrawn = { validate: step('authorize-withdrawal', validateWithdrawal), require: [] as const, evolve: step('withdraw', withdraw) };
export interface Call<I extends Input> { readonly requestId: string; readonly input: I }
export function leaveCommands(repository: LeaveRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor }); // trusted host identity, never chosen in the call
  const request = <I extends Input>(operation: Operation, call: Call<I>): Request => ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  const target = <I extends Input>(operation: Operation) => defineRequestTarget({
    operation: `leave.${operation}.v1`,
    load: (call: Call<I>) => repository.load(call.input, identity),
    save: (change: Change, execution) => repository.save(request(operation, execution.request), change),
  });
  const commands = { submit: target<SubmitInput>('submit').on(submitted), approve: target<Input>('approve').on(approved), withdraw: target<Input>('withdraw').on(withdrawn) };
  // Heterogeneous request types stay concrete; a shared wrapper is not necessary for three registrations.
  return {
    submit: withReplay(commands.submit, { lookup: call => repository.receipt(request('submit', call)), resolveAfter }),
    approve: withReplay(commands.approve, { lookup: call => repository.receipt(request('approve', call)), resolveAfter }),
    withdraw: withReplay(commands.withdraw, { lookup: call => repository.receipt(request('withdraw', call)), resolveAfter }),
  };
}
function resolveAfter(error: { kind: string }) { return error.kind === 'Conflict' || error.kind === 'InvalidState' || error.kind === 'StorageUnavailable'; }
export function leaveApplication(repository: LeaveRepository, actor: Actor, initial: Account) {
  const commands = leaveCommands(repository, actor);
  const replace = (_before: Account, after: Account) => after;
  return defineApplication({ initial: () => initial,
    operations: { submit: replayOperation(commands.submit, replace), approve: replayOperation(commands.approve, replace), withdraw: replayOperation(commands.withdraw, replace) },
    view: state => ({ account: state.data, balance: balance(state.data), busy: state.kind === 'running', error: state.kind === 'failed' ? state.error.kind : null }),
  });
}
