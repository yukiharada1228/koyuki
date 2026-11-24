import { ok, err, type Result } from '../core.js';
import { Execution, fingerprint, type Journal } from '../comparison/kernel.js';
import { decide, type ApprovalEvent, type Event, type Input, type Policy, type State, type SavedOrder, type TransitionError } from './domain.js';
import { Backend } from './backend.js';
export interface RecordState { revision: number; input: Input; policy: Policy; state: State; events: Map<string, string> }
export class StateStore { readonly records = new Map<string, RecordState>(); }
export type Failure = { slot: string; category: 'business' | 'infrastructure'; message: string };
export type Outcome = { status: 'waiting'; stage: 'manager' | 'finance'; requestId: string }
  | { status: 'complete' }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; failures: readonly Failure[] };
export class Host {
  constructor(readonly backend: Backend, readonly execution: Execution, readonly store = new StateStore()) {}
  start(input: Input, policy: Policy): void {
    if (!policy.version || !Number.isSafeInteger(policy.managerFrom) || policy.managerFrom <= 0 ||
      (policy.financeFrom !== null && (!Number.isSafeInteger(policy.financeFrom) || policy.financeFrom < policy.managerFrom)))
      throw new Error('InvalidPolicy');
    const previous = this.store.records.get(input.id);
    if (previous) {
      if (fingerprint(previous.input) !== fingerprint(input) || fingerprint(previous.policy) !== fingerprint(policy)) throw new Error('StartIdentityMismatch');
      return;
    }
    this.store.records.set(input.id, { revision: 0, input: structuredClone(input), policy: structuredClone(policy), state: { kind: 'draft', input: structuredClone(input) }, events: new Map() });
  }
  read(id: string): RecordState {
    const record = this.store.records.get(id); if (!record) throw new Error('NotFound');
    return structuredClone(record);
  }
  apply(id: string, revision: number, event: Event): boolean {
    const record = this.store.records.get(id); if (!record) throw new Error('NotFound');
    if (record.revision !== revision) return false;
    const next = decide(record.state, event, record.policy);
    if (!next.ok) throw new Error(`TransitionDefect:${next.error}`);
    this.store.records.set(id, { ...record, revision: revision + 1, state: structuredClone(next.value) });
    return true;
  }
  receive(event: ApprovalEvent): Result<'applied' | 'duplicate', TransitionError | 'EventIdentityMismatch' | 'NotFound'> {
    const record = this.store.records.get(event.orderId); if (!record) return err('NotFound');
    const existing = record.events.get(event.eventId), signature = fingerprint(event);
    if (existing !== undefined) return existing === signature ? ok('duplicate') : err('EventIdentityMismatch');
    const next = decide(record.state, event, record.policy); if (!next.ok) return next;
    const events = new Map(record.events); events.set(event.eventId, signature);
    // Synchronous single-process compare/update: state + consumed event move together.
    this.store.records.set(event.orderId, { ...record, revision: record.revision + 1, state: structuredClone(next.value), events });
    return ok('applied');
  }
  async commit(id: string, record: RecordState): Promise<readonly Failure[]> {
    if (record.state.kind !== 'ready') throw new Error('ExpectedReady');
    try {
      const result = await this.execution.call(`order:${id}`, 'commit', this.backend.commit, record.state.order);
      if (!result.ok) return [{ slot: 'commit', category: 'business', message: result.error.kind }];
      this.apply(id, record.revision, { type: 'saved', order: result.value }); return [];
    } catch (error) { return [{ slot: 'commit', category: 'infrastructure', message: String(error) }]; }
  }
  async fulfillOne(id: string, slot: 'notify' | 'ship', order: SavedOrder): Promise<readonly Failure[]> {
    try {
      const result = await this.execution.call(`order:${id}`, `fulfill/${slot}`, this.backend[slot], order);
      return result.ok ? [] : [{ slot, category: 'business', message: result.error.kind }];
    } catch (error) { return [{ slot, category: 'infrastructure', message: String(error) }]; }
  }
  async fulfill(id: string, record: RecordState, slots: readonly ('notify' | 'ship')[]): Promise<readonly Failure[]> {
    if (record.state.kind !== 'committed') throw new Error('ExpectedCommitted');
    const order = record.state.order;
    // Each child is settled, so we never report completion while another child still runs.
    const results = await Promise.all(slots.map(slot => this.fulfillOne(id, slot, order)));
    const failures = results.flat();
    if (!failures.length) this.apply(id, record.revision, { type: 'fulfilled' });
    return failures;
  }
}
