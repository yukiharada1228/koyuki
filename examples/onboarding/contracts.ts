import type { ActionReport, Result } from 'koyuki';
export type Actor = Readonly<{ id: string; role: 'employee' | 'manager'; active: boolean }>;
type Base = Readonly<{ id: string; version: number; ownerId: string; amountCents: number }>;
export type Draft = Base & Readonly<{ state: 'draft' }>;
export type Submitted = Base & Readonly<{ state: 'submitted'; approverId: string; submittedBy: string }>;
export type Approved = Omit<Submitted, 'state'> & Readonly<{ state: 'approved'; approvedBy: string }>;
export type Rejected = Omit<Submitted, 'state'> & Readonly<{ state: 'rejected'; rejectedBy: string; reason: string }>;
export type Expense = Draft | Submitted | Approved | Rejected;
export type VersionInput = Readonly<{ id: string; expectedVersion: number }>;
export type SubmitInput = VersionInput & Readonly<{ approverId: string }>;
export type RejectInput = VersionInput & Readonly<{ reason: string }>;
export type Loaded<I> = Readonly<{ input: I; current: Expense; actor: Actor }>;
export type RuleError = Readonly<{ kind: 'Denied' | 'InvalidInput' | 'WrongState' | 'Conflict' }>;
export type StoreError = Readonly<{ kind: 'NotFound' | 'SaveUnavailable' | 'Conflict' }>;
export type Failure = RuleError | StoreError;
export interface Ports {
  readonly load: <I extends VersionInput>(input: I) => Promise<Result<Loaded<I>, StoreError>>;
  readonly save: <T extends Expense>(next: T) => Promise<Result<T, StoreError>>;
}
type Command<I, O> = ((input: I) => Promise<Result<O, Failure>>) & {
  readonly runDetailed: (input: I) => Promise<ActionReport<O, Failure>>;
};
export interface ExpenseCommands {
  readonly submit: Command<SubmitInput, Submitted>;
  readonly approve: Command<VersionInput, Approved>;
  readonly reject: Command<RejectInput, Rejected>;
}
