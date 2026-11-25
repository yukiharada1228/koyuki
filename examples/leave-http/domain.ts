import { ok, err, type Result } from 'koyuki';
export type Leave = Readonly<{ id: string; days: number } & (
  { kind: 'pending' } | { kind: 'approved'; by: string } | { kind: 'withdrawn' }
)>;
export interface Account { readonly employee: string; readonly granted: number; readonly version: number; readonly leaves: readonly Leave[] }
export interface Actor { readonly id: string; readonly role: 'employee' | 'manager'; readonly active: boolean }
export interface Input { readonly employee: string; readonly leaveId: string; readonly expectedVersion: number }
export interface SubmitInput extends Input { readonly days: number }
export interface Loaded<I extends Input = Input> { readonly account: Account; readonly actor: Actor; readonly input: I }
export type RuleError = { kind: 'Forbidden' } | { kind: 'InvalidState' } | { kind: 'InvalidInput' } | { kind: 'InsufficientDays' };
declare const proof: unique symbol;
export type Submission = Loaded<SubmitInput> & { readonly [proof]: 'submission' };
export type Funded = Loaded<SubmitInput> & { readonly [proof]: 'funded' };
export type Approval = Loaded & { readonly pending: Extract<Leave, { kind: 'pending' }>; readonly [proof]: 'approval' };
export type Withdrawal = Loaded & { readonly pending: Extract<Leave, { kind: 'pending' }>; readonly [proof]: 'withdrawal' };
export type Change = Readonly<{ expectedVersion: number; next: Account }> & { readonly [proof]: 'change' };
export function balance(account: Account) {
  const reserved = account.leaves.filter(l => l.kind === 'pending').reduce((n, l) => n + l.days, 0);
  const used = account.leaves.filter(l => l.kind === 'approved').reduce((n, l) => n + l.days, 0);
  return { granted: account.granted, reserved, used, available: account.granted - reserved - used };
}
export function validInput(input: unknown): input is Input {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;
  return typeof i.employee === 'string' && !!i.employee.trim() && typeof i.leaveId === 'string' && !!i.leaveId.trim() &&
    typeof i.expectedVersion === 'number' && Number.isSafeInteger(i.expectedVersion) && i.expectedVersion > 0;
}
export function validateSubmission(command: Loaded<SubmitInput>): Result<Submission, RuleError> {
  if (!validInput(command.input) || !Number.isSafeInteger(command.input.days) || command.input.days <= 0) return err({ kind: 'InvalidInput' });
  if (!command.actor.active || command.actor.id !== command.account.employee) return err({ kind: 'Forbidden' });
  if (command.account.leaves.some(l => l.id === command.input.leaveId)) return err({ kind: 'InvalidState' });
  return ok(command as Submission);
}
export function requireDays(command: Submission): Result<Funded, RuleError> {
  if (balance(command.account).available < command.input.days) return err({ kind: 'InsufficientDays' });
  return ok(command as unknown as Funded);
}
function change(account: Account, leaves: readonly Leave[]): Change {
  return Object.freeze({ expectedVersion: account.version,
    next: Object.freeze({ ...account, version: account.version + 1, leaves: Object.freeze(leaves.map(l => Object.freeze({ ...l }))) }) }) as Change;
}
export function submit(command: Funded): Result<Change, never> {
  return ok(change(command.account, [...command.account.leaves, { id: command.input.leaveId, days: command.input.days, kind: 'pending' }]));
}
export function validateApproval(command: Loaded): Result<Approval, RuleError> {
  if (!command.actor.active || command.actor.role !== 'manager' || command.actor.id === command.account.employee) return err({ kind: 'Forbidden' });
  const pending = command.account.leaves.find(l => l.id === command.input.leaveId);
  if (!pending || pending.kind !== 'pending') return err({ kind: 'InvalidState' });
  return ok({ ...command, pending } as Approval);
}
export function approve(command: Approval): Result<Change, never> {
  return ok(change(command.account, command.account.leaves.map(l => l.id === command.pending.id ? { ...command.pending, kind: 'approved', by: command.actor.id } : l)));
}
export function validateWithdrawal(command: Loaded): Result<Withdrawal, RuleError> {
  if (!command.actor.active || command.actor.id !== command.account.employee) return err({ kind: 'Forbidden' });
  const pending = command.account.leaves.find(l => l.id === command.input.leaveId);
  if (!pending || pending.kind !== 'pending') return err({ kind: 'InvalidState' });
  return ok({ ...command, pending } as Withdrawal);
}
export function withdraw(command: Withdrawal): Result<Change, never> {
  return ok(change(command.account, command.account.leaves.map(l => l.id === command.pending.id ? { id: l.id, days: l.days, kind: 'withdrawn' } : l)));
}
export function restoreAccount(raw: unknown): Result<Account, { kind: 'CorruptLeave' }> {
  const fail = () => err({ kind: 'CorruptLeave' } as const);
  if (!raw || typeof raw !== 'object') return fail();
  const a = raw as Account;
  if (typeof a.employee !== 'string' || !a.employee.trim() || !Number.isSafeInteger(a.granted) || a.granted < 0 ||
      !Number.isSafeInteger(a.version) || a.version < 1 || !Array.isArray(a.leaves)) return fail();
  const ids = new Set<string>();
  const leaves: Leave[] = [];
  for (const l of a.leaves) {
    if (!l || typeof l.id !== 'string' || !l.id.trim() || ids.has(l.id) || !Number.isSafeInteger(l.days) || l.days <= 0) return fail();
    ids.add(l.id);
    if (l.kind === 'approved') {
      if (typeof l.by !== 'string' || !l.by.trim() || l.by === a.employee) return fail();
      leaves.push(Object.freeze({ id: l.id, days: l.days, kind: 'approved', by: l.by }));
    } else if (l.kind === 'pending' || l.kind === 'withdrawn') leaves.push(Object.freeze({ id: l.id, days: l.days, kind: l.kind }));
    else return fail();
  }
  const account: Account = Object.freeze({ employee: a.employee, granted: a.granted, version: a.version, leaves: Object.freeze(leaves) });
  const b = balance(account);
  const expectedVersion = 1 + leaves.reduce((n, l) => n + (l.kind === 'pending' ? 1 : 2), 0);
  if (a.version !== expectedVersion || !Number.isSafeInteger(b.reserved + b.used) || b.available < 0) return fail();
  return ok(account);
}
