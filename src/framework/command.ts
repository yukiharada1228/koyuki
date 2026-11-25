import type { Result } from './result.js';
import type { Workflow } from './workflow.js';
import { bindMutation } from './workflow.js';
import { defineAction } from './action.js';
/** The common load → pure decision → save convention, declared once. */
export function defineCommand<I, C, LE, O, DE, S, SE>(definition: {
  operation: string;
  loadName?: string;
  load: (input: I) => Promise<Result<C, LE>>;
  decide: Workflow<C, O, DE> & { readonly run: (input: NoInfer<C>) => Result<O, DE> };
  save: (decision: NoInfer<O>) => Promise<Result<S, SE>>;
}) {
  const mutation = bindMutation({ workflow: definition.decide, operation: definition.operation, save: definition.save });
  const action = defineAction({ loadName: definition.loadName ?? `${definition.operation}:load`, load: definition.load, mutation });
  // The mutation escape hatch supports existing prepare/plan and comparison experiments.
  return { ...action, mutation };
}
