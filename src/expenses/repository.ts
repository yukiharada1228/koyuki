import { ok, err, type Result } from '../framework/index.js';
import type { Actor, Change, ExpenseState, Input, Loaded, RejectInput, Draft } from './domain.js';
export type StorageError = { kind: 'CorruptExpense' } | { kind: 'RepositoryUnavailable' };
export type LoadError = { kind: 'NotFound' } | { kind: 'SaveConflict' } | StorageError;
export type SaveError = { kind: 'SaveConflict' } | StorageError;
export interface ExpenseRepository {
  load(input: Input, actor: Actor): Promise<Result<Loaded, LoadError>>;
  loadReject(input: RejectInput, actor: Actor): Promise<Result<Loaded<RejectInput>, LoadError>>;
  save(change: Change): Promise<Result<ExpenseState, SaveError>>;
}
/** Single-process test adapter. Actors are trusted host claims, not request payloads. */
export class MemoryExpenses implements ExpenseRepository {
  private readonly records = new Map<string, ExpenseState>();
  readonly calls: string[] = [];
  constructor(drafts: readonly Draft[]) { for (const draft of drafts) this.records.set(draft.id, structuredClone(draft)); }
  read(id: string) { return structuredClone(this.records.get(id)); }
  list() { return structuredClone([...this.records.values()]); }
  private readInput<I extends Input>(input: I, actor: Actor): Result<Loaded<I>, LoadError> {
    const current = this.read(input.id); if (!current) return err({ kind: 'NotFound' });
    if (current.version !== input.expectedVersion) return err({ kind: 'SaveConflict' });
    return ok({ current, actor: structuredClone(actor), input: structuredClone(input) });
  }
  async load(input: Input, actor: Actor) { this.calls.push('load'); return this.readInput(input, actor); }
  async loadReject(input: RejectInput, actor: Actor) { this.calls.push('load-reject'); return this.readInput(input, actor); }
  async save(change: Change): Promise<Result<ExpenseState, SaveError>> {
    this.calls.push('save');
    const current = this.records.get(change.next.id);
    if (!current || current.version !== change.expectedVersion || change.next.version !== current.version + 1 ||
        change.next.owner !== current.owner || change.next.amount !== current.amount || change.next.receipt !== current.receipt) return err({ kind: 'SaveConflict' });
    // Compare and update without an await models one atomic storage operation.
    this.records.set(change.next.id, structuredClone(change.next)); return ok(structuredClone(change.next));
  }
}
