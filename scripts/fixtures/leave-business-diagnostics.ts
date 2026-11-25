import { business } from 'koyuki';
import { ok, type Result } from 'koyuki';
import { leaveCommands } from './application.js';
import { validateSubmission, submit, type Loaded, type SubmitInput, type Change } from './domain.js';
import type { LeaveRepository } from './repository.js';
declare const repository: LeaveRepository;
const commands = leaveCommands(repository, { id: 'owner', role: 'employee', active: true });
// reject-next-line: operation-specific required field
commands.submit({ requestId: 'missing-days', input: { employee: 'owner', leaveId: 'one', expectedVersion: 1 } });
// reject-next-line: all operation inputs preserve the version
commands.approve({ requestId: 'missing-version', input: { employee: 'owner', leaveId: 'one' } });
declare const load: (n: number) => Promise<Result<Loaded<SubmitInput>, never>>;
const save = async (value: Change) => ok(value);
business({ name: 'skip-proof', load, save, operations: {
  // reject-next-line: omitted funding proof
  submit: [validateSubmission, submit],
} });
// reject-next-line: async rules are not pure synchronous stages
business({ name: 'async', load: async (n: number) => ok(n), save: async (n: number) => ok(n), operations: { change: [async (n: number) => ok(n)] } });
// reject-next-line: an empty list is not an operation
business({ name: 'empty', load: async (n: number) => ok(n), save: async (n: number) => ok(n), operations: { change: [] } });
// reject-next-line: a replay save must return an atomic Execution envelope
business({ name: 'replay', load: async (n: number) => ok(n), save: async (n: number) => ok(n), operations: { change: [(n: number) => ok(n)] }, replay: { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: [] } });

type RawState = { kind: 'raw' }; type CheckedState = { kind: 'checked' }; type AllowedState = { kind: 'allowed' }; type DoneState = { kind: 'done' };
const readState = async (_id: string): Promise<Result<RawState, never>> => ok({ kind: 'raw' });
const checkState = (_value: RawState): Result<CheckedState, 'Invalid'> => ok({ kind: 'checked' });
const allowState = (_value: CheckedState): Result<AllowedState, 'Denied'> => ok({ kind: 'allowed' });
const finishState = (_value: AllowedState): Result<DoneState, never> => ok({ kind: 'done' });
const saveState = async (value: DoneState) => ok(value);
// reject-next-line: operation and first-stage input must be identifiable
business({ name: 'first', load: readState, save: saveState, operations: { wrongFirst: [allowState, finishState] } });
// reject-next-line: operation and missing intermediate proof must be identifiable
business({ name: 'proof', load: readState, save: saveState, operations: { omittedPermission: [checkState, finishState] } });
// reject-next-line: operation and last-stage save mismatch must be identifiable
business({ name: 'save', load: readState, save: saveState, operations: { wrongSave: [checkState, allowState] } });
// reject-next-line: operation-specific load must be used when diagnosing its first stage
business({ name: 'override', load: async (_id: string) => ok(1), save: saveState, operations: { overridden: { load: readState, run: [allowState, finishState] } } });
const symbolOperation = Symbol('unsupported');
// reject-next-line: Symbol operation keys cannot produce callable commands
business({ name: 'symbol', load: readState, save: saveState, operations: { [symbolOperation]: [checkState, allowState, finishState] } });
// reject-next-line: numeric operation names also retain the stage-location diagnostic
business({ name: 'numeric', load: readState, save: saveState, operations: { 0: [allowState, finishState] } });
