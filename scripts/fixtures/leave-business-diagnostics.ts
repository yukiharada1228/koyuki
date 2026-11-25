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
