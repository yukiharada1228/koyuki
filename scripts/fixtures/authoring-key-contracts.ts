// Historical path; all contracts use the current declaration API.
import { defineOperation, createApplication } from 'koyuki/experimental';
import { ok, process, workflow, type Result, type Process } from 'koyuki';
const key = defineOperation('contract', () => ({
  load: async (input: Readonly<{ id: string }>): Promise<Result<number, 'Unavailable'>> => ok(input.id.length),
  execute: (value: number) => ok(value),
  save: async value => ok(value),
}));
declare const app: ReturnType<typeof createApplication>;
const result = app.execute(key, { id: 'one' });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<typeof result, Promise<Result<number, 'Unavailable'>>> = true; void exact;
// @ts-expect-error Input must not widen to accommodate a caller.
void app.execute(key, { id: 1 });
// @ts-expect-error Required input must remain required.
void app.execute(key, {});
const processKey = defineOperation('detailed-process', () => ({
  load: process<number>().effect('read', async input => ok(input)),
  execute: process<number>().through(workflow('double', (value: number) => ok(value * 2))),
  save: async (value: number) => ok(String(value)),
}));
const processResult = app.execute(processKey, 3);
const exactProcess: Equal<typeof processResult, Promise<Result<string, never>>> = true; void exactProcess;
// @ts-expect-error The IO process must accept the actual load output.
defineOperation('bad-input', () => ({ load: async (_input: string) => ok(1), execute: process<string>().effect('text', async text => ok(text.length)), save: async (value: number) => ok(value) }));
// @ts-expect-error Save must accept the IO process output.
defineOperation('bad-save', () => ({ load: async (_input: string) => ok(1), execute: process<number>().effect('text', async value => ok(String(value))), save: async (value: number) => ok(value) }));
const namedProcessType: Process<number, number, never> = process<number>(); void namedProcessType;
import { validateApproval, type Loaded } from './domain/expenses.js';
import { approveWithBudgetPolicy } from './expense-budget.js';
// @ts-expect-error Authorization alone does not supply the required budget policy.
process<Loaded>().through(workflow('authorize', validateApproval)).through(approveWithBudgetPolicy);
const captured = app.executeDetailed(key, { id: 'one' }, { input: (_value, step) => step, result: result => result.ok });
const exactCapturedResult: Equal<Awaited<typeof captured>['result'], Result<number, 'Unavailable'>> = true; void exactCapturedResult;
const exactCapturedValue: Equal<Awaited<typeof captured>['observations'][number]['result'], boolean> = true; void exactCapturedValue;
// @ts-expect-error Capture must retain required input.
void app.executeDetailed(key, {}, { input: () => null, result: result => result.ok });
import { approveLeave, type PendingLeave, type LeaveApprover, type ApprovedLeave } from './leave-domain.js';
const pendingLeave: PendingLeave = { kind: 'pending', id: 'leave-1', owner: 'owner', days: 2 };
const eligibleApprover: LeaveApprover = { id: 'boss', role: 'manager', active: true };
const missingAuthorization = { current: pendingLeave, actor: eligibleApprover };
// @ts-expect-error Public fields are valid; the authorization proof is missing.
approveLeave(missingAuthorization);
// @ts-expect-error A pending-only loader cannot skip authorization.
defineOperation('skip-leave-authorization', () => ({ load: async (_input: string) => ok(missingAuthorization), execute: workflow('approve', approveLeave), save: async (value: ApprovedLeave) => ok(value) }));
