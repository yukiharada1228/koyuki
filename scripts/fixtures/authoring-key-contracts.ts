import { operationKey, createApplication, useOperation } from 'koyuki/experimental';
import { ok, err, process, workflow, type Result, type Process } from 'koyuki';
const key = operationKey('contract', () => ({
  run: async (_input: Readonly<{ id: string }>): Promise<Result<number, 'Unavailable'>> => ok(1),
  runDetailed: async (_input: Readonly<{ id: string }>) => ({ result: ok(1), trace: [], plan: null }),
}));
declare const app: ReturnType<typeof createApplication>;
const result = app.dispatch(key, { id: 'one' });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<typeof result, Promise<Result<number, 'Unavailable'>>> = true;
void exact;
// @ts-expect-error Inferred key input must not widen to accommodate the caller.
void app.dispatch(key, { id: 1 });
// @ts-expect-error Required input must remain required.
void app.dispatch(key, {});
// @ts-expect-error Detailed input must accept the run input.
operationKey('wrong-input', () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: number) => ({ result: ok(1), trace: [], plan: null }) }));
// @ts-expect-error Detailed success must agree with run success.
operationKey('wrong-output', () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: string) => ({ result: ok('wrong'), trace: [], plan: null }) }));
// @ts-expect-error Detailed error cannot expand the run error union.
operationKey('wrong-error', () => ({ run: async (_input: string): Promise<Result<number, 'Expected'>> => ok(1), runDetailed: async (_input: string) => ({ result: err<'Unexpected'>('Unexpected'), trace: [], plan: null }) }));
// @ts-expect-error Key creation takes a synchronous custom Hook, not an async factory.
operationKey('async-hook', async () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: string) => ({ result: ok(1), trace: [], plan: null }) }));

function useDetailedProcess() {
  return useOperation({ name: 'detailed-process',
    load: process<number>().effect('read', async input => ok(input)),
    execute: process<number>().through(workflow('double', (value: number) => ok(value * 2))),
    save: async (value: number) => ok(String(value)),
  });
}
const processKey = operationKey('detailed-process', useDetailedProcess);
const processResult = app.dispatch(processKey, 3);
const exactProcess: Equal<typeof processResult, Promise<Result<string, never>>> = true; void exactProcess;
function invalidProcesses() {
  // @ts-expect-error The explicit IO process must accept the actual load output.
  useOperation({ name: 'bad-input', load: async (_input: string) => ok(1), execute: process<string>().effect('text', async text => ok(text.length)), save: async (value: number) => ok(value) });
  // @ts-expect-error Save must accept the IO process output.
  useOperation({ name: 'bad-save', load: async (_input: string) => ok(1), execute: process<number>().effect('text', async value => ok(String(value))), save: async (value: number) => ok(value) });
}
void invalidProcesses;

const namedProcessType: Process<number, number, never> = process<number>();
void namedProcessType;

// The middle policy read is a typed prerequisite, not an optional callback.
import { validateApproval, type Loaded } from './domain/expenses.js';
import { approveWithBudgetPolicy } from './expense-budget.js';
function omittedPolicyRead() {
  // @ts-expect-error Authorization alone does not supply the required budget policy.
  process<Loaded>().through(workflow('authorize', validateApproval)).through(approveWithBudgetPolicy);
}
void omittedPolicyRead;
