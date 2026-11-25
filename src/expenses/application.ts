import { defineTarget, defineApplication, operation, step, defineTransition, withInput } from '../framework/index.js';
import { validateSubmission, routeSubmission, submitRouted, validateEdit, edit, returnForCorrection, validateApproval, approve, validateRejection, reject, type Actor, type Input, type RejectInput, type EditInput, type ExpenseState } from './domain.js';
import type { ExpenseRepository } from './repository.js';
export const submitted = defineTransition({ validate: step('validate-submission', validateSubmission), require: [step('route-submission', withInput(routeSubmission))], evolve: step('submit', submitRouted) });
export const approved = defineTransition({ validate: step('authorize-approval', validateApproval), evolve: step('approve', approve) });
export const rejected = defineTransition({ validate: step('authorize-rejection', validateRejection), evolve: step('reject', reject) });
export const returned = defineTransition({ validate: step('authorize-return', validateRejection), evolve: step('return', returnForCorrection) });
export const edited = defineTransition({ validate: step('validate-edit', validateEdit), evolve: step('edit', edit) });
export function expenseModel(repository: ExpenseRepository, actor: Actor) {
  // Host injects the authenticated actor once; users cannot choose a role in each event.
  const identity = Object.freeze({ ...actor });
  const save = repository.save.bind(repository);
  return {
    change: defineTarget({ operation: 'expense.change.v1', load: (input: Input) => repository.load(input, identity), save }),
    correction: defineTarget({ operation: 'expense.edit.v1', load: (input: EditInput) => repository.load(input, identity), save }),
    rejection: defineTarget({ operation: 'expense.reject.v1', load: (input: RejectInput) => repository.loadReject(input, identity), save }),
  };
}
export function expenseApplication(repository: ExpenseRepository, actor: Actor, initial: readonly ExpenseState[]) {
  const model = expenseModel(repository, actor);
  const replace = (state: readonly ExpenseState[], expense: ExpenseState) => state.map(current => current.id === expense.id ? expense : current);
  return defineApplication({
    initial: () => initial,
    operations: {
      return: operation(model.rejection.on(returned), replace),
      edit: operation(model.correction.on(edited), replace),
      submit: operation(model.change.on(submitted), replace),
      approve: operation(model.change.on(approved), replace),
      reject: operation(model.rejection.on(rejected), replace),
    },
    view: state => ({ expenses: state.data, busy: state.kind === 'running', error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null }),
  });
}
