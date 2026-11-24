import { defineTarget, defineApplication, operation, step } from '../framework/index.js';
import { validateSubmission, submit, validateApproval, approve, validateRejection, reject, type Actor, type Input, type RejectInput, type ExpenseState } from './domain.js';
import type { ExpenseRepository } from './repository.js';
export const submitted = { validate: step('validate-submission', validateSubmission), require: [] as const, evolve: step('submit', submit) };
export const approved = { validate: step('authorize-approval', validateApproval), require: [] as const, evolve: step('approve', approve) };
export const rejected = { validate: step('authorize-rejection', validateRejection), require: [] as const, evolve: step('reject', reject) };
export function expenseModel(repository: ExpenseRepository, actor: Actor) {
  // Host injects the authenticated actor once; users cannot choose a role in each event.
  const identity = Object.freeze({ ...actor });
  const save = repository.save.bind(repository);
  return {
    change: defineTarget({ operation: 'expense.change.v1', load: (input: Input) => repository.load(input, identity), save }),
    rejection: defineTarget({ operation: 'expense.reject.v1', load: (input: RejectInput) => repository.loadReject(input, identity), save }),
  };
}
export function expenseApplication(repository: ExpenseRepository, actor: Actor, initial: readonly ExpenseState[]) {
  const model = expenseModel(repository, actor);
  const replace = (state: readonly ExpenseState[], expense: ExpenseState) => state.map(current => current.id === expense.id ? expense : current);
  return defineApplication({
    initial: () => initial,
    operations: {
      submit: operation(model.change.on(submitted), replace),
      approve: operation(model.change.on(approved), replace),
      reject: operation(model.rejection.on(rejected), replace),
    },
    view: state => ({ expenses: state.data, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error.kind : null }),
  });
}
