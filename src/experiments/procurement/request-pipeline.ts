import { workflow, withInput, ok } from '../../framework/index.js';
import { checkRequestCreation, parseRequestLines, requestCreationPlan } from './domain.js';

// Ordinary domain functions describe prerequisites, parsing and the resulting plan.
// The runtime supplies Result composition and preserves the checked input.
export const requestCreationDecision = workflow('authorize-creation', checkRequestCreation)
  .then('parse-lines', withInput(value => parseRequestLines(value.input.lines)))
  .then('create-request-plan', ({ input, value }) => ok(requestCreationPlan(input, value)));
