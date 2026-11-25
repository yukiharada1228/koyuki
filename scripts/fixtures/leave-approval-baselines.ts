// Comparison scope: pure approval decisions only. No equivalent TS persistence runtime is claimed.
import type { Result } from 'koyuki';
import { validateApproval, approve, type Loaded, type Change, type RuleError } from './domain.js';
export function inlineApproval(input: Loaded): Result<Change, RuleError> {
  const validation = validateApproval(input);
  if (!validation.ok) return validation;
  return approve(validation.value);
}
function chain<I, O, E, F>(previous: Result<I, E>, next: (input: I) => Result<O, F>): Result<O, E | F> {
  return previous.ok ? next(previous.value) : previous;
}
export function helperApproval(input: Loaded): Result<Change, RuleError> {
  return chain(validateApproval(input), approve);
}
