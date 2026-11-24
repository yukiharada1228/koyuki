import { ok, err } from '../core.js';
import { fingerprint, operation } from '../comparison/kernel.js';
import type { ApprovedOrder, SavedOrder } from './domain.js';
export type CommitError = { kind: 'SaveConflict' };
export type EffectError = { kind: 'ProviderRejected' };
export class Backend {
  readonly saved = new Map<string, SavedOrder>();
  readonly deliveries: string[] = [];
  readonly shipments: string[] = [];
  readonly calls: string[] = [];
  private readonly accepted = new Set<string>();
  saveConflict = false;
  notifyFailure: 'none' | 'infrastructure' | 'business' = 'none';
  shipFailure: 'none' | 'infrastructure' | 'business' = 'none';
  notifyGate?: () => Promise<void>;
  shipGate?: () => Promise<void>;
  readonly commit = operation<ApprovedOrder, SavedOrder, CommitError>({ name: 'approval-order.commit.v1', run: async input => {
    this.calls.push(`commit:${input.id}`);
    const existing = this.saved.get(input.id);
    if (existing) {
      const { receipt, kind, ...body } = existing;
      if (fingerprint({ ...body, kind: 'approved-order' }) !== fingerprint(input)) throw new Error('PayloadMismatch');
      return ok(existing);
    }
    if (this.saveConflict) return err({ kind: 'SaveConflict' });
    const saved: SavedOrder = { ...input, kind: 'saved-order', receipt: `receipt:${input.id}` };
    this.saved.set(input.id, saved); return ok(saved);
  }});
  readonly notify = operation<SavedOrder, void, EffectError>({ name: 'approval-order.notify.v1', run: async (input, context) => {
    this.calls.push(`notify:${input.id}`); await this.notifyGate?.();
    if (this.notifyFailure === 'infrastructure') throw new Error('MailUnavailable');
    if (this.notifyFailure === 'business') return err({ kind: 'ProviderRejected' });
    if (!this.accepted.has(context.idempotencyKey)) this.deliveries.push(input.id);
    this.accepted.add(context.idempotencyKey); return ok(undefined);
  }});
  readonly ship = operation<SavedOrder, void, EffectError>({ name: 'approval-order.ship.v1', run: async (input, context) => {
    this.calls.push(`ship:${input.id}`); await this.shipGate?.();
    if (this.shipFailure === 'infrastructure') throw new Error('ShippingUnavailable');
    if (this.shipFailure === 'business') return err({ kind: 'ProviderRejected' });
    if (!this.accepted.has(context.idempotencyKey)) this.shipments.push(input.id);
    this.accepted.add(context.idempotencyKey); return ok(undefined);
  }});
}
