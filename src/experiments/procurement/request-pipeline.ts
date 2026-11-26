import { withInput, ok } from '../../framework/index.js';
import { parseRequestLines, requestCreationPlan, requestEditPlan,
  type CheckedRequestCreation, type EditableRequest, type ParsedRequestLines } from './domain.js';

// The same parser retains each operation's checked context without depending on
// creation/edit authorization. Operations declare the required guards separately.
function parseInputLines<T extends { readonly input: { readonly lines: unknown } }>(value: T) {
  return parseRequestLines(value.input.lines);
}
export const parsedRequestInput = withInput(parseInputLines);

export function creationPlan<T extends CheckedRequestCreation>({ input, value }: Readonly<{ input: T; value: ParsedRequestLines }>) {
  return ok(requestCreationPlan(input, value));
}
export function editPlan<T extends EditableRequest>({ input, value }: Readonly<{ input: T; value: ParsedRequestLines }>) {
  return ok(requestEditPlan(input, value));
}
