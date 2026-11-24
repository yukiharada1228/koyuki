import { ok, err, type Result } from 'koyuki';
import { expenseWorkflow } from './policy.js';
interface Data { readonly id: string; readonly owner: string; readonly amount: number; readonly receipt: boolean; readonly version: number }
export type Draft = Readonly<Data & { kind: 'draft' }>;
export type PendingManager = Readonly<Data & { kind: 'manager'; receipt: true }>;
export type PendingFinance = Readonly<Data & { kind: 'finance'; receipt: true; manager: string }>;
export type Approved =
  | Readonly<Data & { kind: 'approved'; approval: { kind: 'automatic' } }>
  | Readonly<Data & { kind: 'approved'; receipt: true; approval: { kind: 'manager'; manager: string } }>
  | Readonly<Data & { kind: 'approved'; receipt: true; approval: { kind: 'finance'; manager: string; finance: string } }>;
export type Rejected = Readonly<Data & { kind: 'rejected'; by: string; reason: string }>;
export type ExpenseState = Draft | PendingManager | PendingFinance | Approved | Rejected;
export interface Actor { readonly id: string; readonly role: 'employee' | 'manager' | 'finance'; readonly active: boolean }
export interface Input { readonly id: string; readonly expectedVersion: number }
export interface RejectInput extends Input { readonly reason: string }
export interface Loaded<I = Input> { readonly current: ExpenseState; readonly actor: Actor; readonly input: I }
declare const proof: unique symbol;
export type Submission = Loaded & { readonly current: Draft; readonly [proof]: 'submission' };
export type AuthorizedApproval = Loaded & { readonly current: PendingManager | PendingFinance; readonly [proof]: 'approval' };
export type AuthorizedRejection = Loaded<RejectInput> & { readonly current: PendingManager | PendingFinance; readonly [proof]: 'rejection' };
export type Change = Readonly<{ expectedVersion: number; next: ExpenseState }> & { readonly [proof]: 'change' };
function change(current: ExpenseState, next: ExpenseState): Change {
  return Object.freeze({ expectedVersion: current.version, next: Object.freeze(next) }) as Change;
}
export type RuleError = { kind: 'InvalidState' } | { kind: 'Forbidden' } | { kind: 'SelfApproval' } | { kind: 'ReasonRequired' };
export function draftExpense(data: Omit<Data, 'version'>): Result<Draft, { kind: 'InvalidExpense' }> {
  if (!data.id.trim() || !data.owner.trim() || !Number.isSafeInteger(data.amount) || data.amount <= 0 || typeof data.receipt !== 'boolean') return err({ kind: 'InvalidExpense' });
  return ok(Object.freeze({ ...data, version: 1, kind: 'draft' }));
}
function evolvedData(current: ExpenseState): Data {
  return { id: current.id, owner: current.owner, amount: current.amount, receipt: current.receipt, version: current.version + 1 };
}
export function validateSubmission(command: Loaded): Result<Submission, RuleError> {
  if (command.current.kind !== 'draft') return err({ kind: 'InvalidState' });
  if (!command.actor.active || command.actor.id !== command.current.owner) return err({ kind: 'Forbidden' });
  return ok(Object.freeze({ ...command }) as Submission);
}
export function submit(command: Submission) {
  const current = command.current;
  const decision = expenseWorkflow.run({ id: current.id, amount: current.amount, receipt: current.receipt, employeeActive: command.actor.active });
  if (!decision.ok) return decision;
  const data = evolvedData(current);
  const next: ExpenseState = decision.value.route === 'automatic'
    ? { ...data, kind: 'approved', approval: { kind: 'automatic' } }
    : { ...data, kind: 'manager', receipt: true };
  return ok(change(current, next));
}
function authority(command: Loaded): Result<PendingManager | PendingFinance, RuleError> {
  const current = command.current;
  if (current.kind !== 'manager' && current.kind !== 'finance') return err({ kind: 'InvalidState' });
  if (command.actor.id === current.owner) return err({ kind: 'SelfApproval' });
  if (!command.actor.active || command.actor.role !== current.kind) return err({ kind: 'Forbidden' });
  return ok(current);
}
export function validateApproval(command: Loaded): Result<AuthorizedApproval, RuleError> {
  const result = authority(command); if (!result.ok) return result;
  return ok(Object.freeze({ ...command, current: result.value }) as AuthorizedApproval);
}
export function approve(command: AuthorizedApproval): Result<Change, never> {
  const current = command.current, data = evolvedData(current);
  let next: ExpenseState;
  if (current.kind === 'manager') next = current.amount > 100000
    ? { ...data, kind: 'finance', receipt: true, manager: command.actor.id }
    : { ...data, kind: 'approved', receipt: true, approval: { kind: 'manager', manager: command.actor.id } };
  else next = { ...data, kind: 'approved', receipt: true, approval: { kind: 'finance', manager: current.manager, finance: command.actor.id } };
  return ok(change(current, next));
}
export function validateRejection(command: Loaded<RejectInput>): Result<AuthorizedRejection, RuleError> {
  const result = authority(command); if (!result.ok) return result;
  if (typeof command.input.reason !== 'string' || !command.input.reason.trim()) return err({ kind: 'ReasonRequired' });
  return ok(Object.freeze({ ...command, current: result.value, input: Object.freeze({ ...command.input, reason: command.input.reason.trim() }) }) as AuthorizedRejection);
}
export function reject(command: AuthorizedRejection): Result<Change, never> {
  return ok(change(command.current, { ...evolvedData(command.current), ...(command.current.kind === 'finance' ? { manager: command.current.manager } : {}), kind: 'rejected', by: command.actor.id, reason: command.input.reason }));
}

export type CorruptExpense = { kind: 'CorruptExpense' };
/** Persistence boundary: validate both common fields and state-specific evidence. */
export function restoreExpense(raw: unknown): Result<ExpenseState, CorruptExpense> {
  const fail = (): Result<never, CorruptExpense> => err({ kind: 'CorruptExpense' });
  if (!raw || typeof raw !== 'object') return fail();
  const value = raw as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
  if (!text(value.id) || !text(value.owner) || typeof value.amount !== 'number' || !Number.isSafeInteger(value.amount) || value.amount <= 0 ||
      typeof value.receipt !== 'boolean' || typeof value.version !== 'number' || !Number.isSafeInteger(value.version)) return fail();
  const data = { id: value.id, owner: value.owner, amount: value.amount, receipt: value.receipt, version: value.version };
  const reviewer = (v: unknown): v is string => text(v) && v !== data.owner;
  switch (value.kind) {
    case 'draft': return data.version === 1 ? ok(Object.freeze({ ...data, kind: 'draft' })) : fail();
    case 'manager': return data.version === 2 && data.amount > 3000 && data.receipt
      ? ok(Object.freeze({ ...data, kind: 'manager', receipt: true })) : fail();
    case 'finance': return data.version === 3 && data.amount > 100000 && data.receipt && reviewer(value.manager)
      ? ok(Object.freeze({ ...data, kind: 'finance', receipt: true, manager: value.manager })) : fail();
    case 'approved': {
      if (!value.approval || typeof value.approval !== 'object') return fail();
      const approval = value.approval as Record<string, unknown>;
      if (approval.kind === 'automatic' && data.version === 2 && data.amount <= 3000)
        return ok(Object.freeze({ ...data, kind: 'approved', approval: Object.freeze({ kind: 'automatic' as const }) }));
      if (approval.kind === 'manager' && data.version === 3 && data.amount > 3000 && data.amount <= 100000 && data.receipt && reviewer(approval.manager))
        return ok(Object.freeze({ ...data, kind: 'approved', receipt: true, approval: Object.freeze({ kind: 'manager' as const, manager: approval.manager }) }));
      if (approval.kind === 'finance' && data.version === 4 && data.amount > 100000 && data.receipt && reviewer(approval.manager) && reviewer(approval.finance))
        return ok(Object.freeze({ ...data, kind: 'approved', receipt: true, approval: Object.freeze({ kind: 'finance' as const, manager: approval.manager, finance: approval.finance }) }));
      return fail();
    }
    case 'rejected':
      if (!data.receipt || data.amount <= 3000 || !reviewer(value.by) || !text(value.reason)) return fail();
      if (data.version === 3) return ok(Object.freeze({ ...data, kind: 'rejected', by: value.by, reason: value.reason }));
      if (data.version === 4 && data.amount > 100000 && reviewer(value.manager)) return ok(Object.freeze({ ...data, kind: 'rejected', by: value.by, reason: value.reason, manager: value.manager }));
      return fail();
    default: return fail();
  }
}
