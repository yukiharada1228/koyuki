// Unpublished API study: the existing expense domain and persistence adapters are unchanged.
import { business } from './business.js';
import { withInput, type GroupExecution } from '../framework/index.js';
import { validateSubmission, routeSubmission, submitRouted, validateApproval, approve, validateRejection, reject,
  validateEdit, edit, returnForCorrection, type Actor, type Input, type RejectInput, type EditInput, type Change } from '../expenses/domain.js';
import type { ExpenseReplayRepository, ExpenseOperation, ExpenseRequest } from '../expenses/sqlite-replay.js';
import type { RequestInput } from '../expenses/replay.js';
export function expenseBusinessCommands(repository: ExpenseReplayRepository, actor: Actor) {
  const identity = Object.freeze({ ...actor });
  const request = <I extends Input>(operation: ExpenseOperation, call: RequestInput<I>): ExpenseRequest =>
    ({ operation, actor: identity, requestId: call.requestId, input: call.input });
  const route = withInput(routeSubmission);
  return business({
    name: 'expense-api-study',
    // Persisted identifiers are independent of the new API's display namespace.
    operation: (name: ExpenseOperation) => `expense.${name}.v1`,
    load: (call: RequestInput<Input>) => repository.load(call.input, identity),
    save: (change: Change, execution: GroupExecution<ExpenseOperation, RequestInput<Input>>) => repository.saveRequest(request(execution.name, execution.request), change),
    replay: {
      lookup: (execution: GroupExecution<ExpenseOperation, RequestInput<Input>>) => repository.receipt(request(execution.name, execution.request)),
      resolveAfter: ['SaveConflict', 'InvalidState', 'RepositoryUnavailable'],
    },
    operations: {
      submit: [validateSubmission, route, submitRouted],
      approve: [validateApproval, approve],
      reject: { load: (call: RequestInput<RejectInput>) => repository.loadReject(call.input, identity), run: [validateRejection, reject] },
      return: { load: (call: RequestInput<RejectInput>) => repository.load(call.input, identity), run: [validateRejection, returnForCorrection] },
      edit: { load: (call: RequestInput<EditInput>) => repository.load(call.input, identity), run: [validateEdit, edit] },
    },
  });
}
