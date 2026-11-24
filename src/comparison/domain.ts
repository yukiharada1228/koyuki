import { ok, err, type Result } from '../core.js';
import { operation } from './kernel.js';
export type ReservationCandidate = { kind: 'reservation-candidate'; id: string; seats: number };
export type ReservationSaved = { kind: 'reservation-saved'; id: string; seats: number; receipt: string };
export type OrderCandidate = { kind: 'order-candidate'; id: string; amount: number };
export type OrderSaved = { kind: 'order-saved'; id: string; amount: number; receipt: string };
export type Conflict = { kind: 'conflict' };
export type MailRejected = { kind: 'mail-rejected' };
export type AuditRejected = { kind: 'audit-rejected' };
export function prepareReservation(id: string, seats: number): Result<ReservationCandidate, 'InvalidPartySize'> {
  return Number.isSafeInteger(seats) && seats > 0 ? ok({ kind: 'reservation-candidate', id, seats }) : err('InvalidPartySize');
}
export function prepareOrder(id: string, amount: number): Result<OrderCandidate, 'InvalidAmount'> {
  return Number.isSafeInteger(amount) && amount > 0 ? ok({ kind: 'order-candidate', id, amount }) : err('InvalidAmount');
}
export class Backend {
  readonly reservations = new Map<string, ReservationSaved>();
  readonly orders = new Map<string, OrderSaved>();
  readonly mail: string[] = [];
  readonly acceptedMail = new Set<string>();
  readonly events: string[] = [];
  conflict = false;
  auditFailure = false;
  readonly audit = operation<ReservationSaved | OrderSaved, void, AuditRejected>({
    name: 'audit.record.v1', run: async input => {
      this.events.push(`audit:${input.kind}`);
      return this.auditFailure ? err({ kind: 'audit-rejected' }) : ok(undefined);
    },
  });
  mailFailure: 'none' | 'business' | 'infrastructure' = 'none';
  providerIdempotent = true;
  private async send(input: { id: string; receipt: string }, key: string): Promise<Result<void, MailRejected>> {
    this.events.push('notify-attempt');
    if (this.mailFailure === 'infrastructure') throw new Error('ProviderUnavailable');
    if (this.mailFailure === 'business') return err({ kind: 'mail-rejected' });
    if (!this.providerIdempotent || !this.acceptedMail.has(key)) this.mail.push(input.receipt);
    this.acceptedMail.add(key);
    return ok(undefined);
  }
  readonly saveReservation = operation<ReservationCandidate, ReservationSaved, Conflict>({
    name: 'reservation.save.v1', run: async input => {
      this.events.push('save-reservation');
      const existing = this.reservations.get(input.id);
      if (existing) {
        if (existing.seats !== input.seats) throw new Error('PayloadMismatch');
        return ok(existing);
      }
      if (this.conflict) return err({ kind: 'conflict' });
      const saved: ReservationSaved = { ...input, kind: 'reservation-saved', receipt: `reservation:${input.id}` };
      this.reservations.set(input.id, saved); return ok(saved);
    },
  });
  readonly saveOrder = operation<OrderCandidate, OrderSaved, Conflict>({
    name: 'order.save.v1', run: async input => {
      this.events.push('save-order');
      const existing = this.orders.get(input.id);
      if (existing) {
        if (existing.amount !== input.amount) throw new Error('PayloadMismatch');
        return ok(existing);
      }
      if (this.conflict) return err({ kind: 'conflict' });
      const saved: OrderSaved = { ...input, kind: 'order-saved', receipt: `order:${input.id}` };
      this.orders.set(input.id, saved); return ok(saved);
    },
  });
  readonly notifyReservation = operation<ReservationSaved, void, MailRejected>({
    name: 'reservation.notify.v1', run: (input, context) => this.send(input, context.idempotencyKey),
  });
  readonly notifyOrder = operation<OrderSaved, void, MailRejected>({
    name: 'order.notify.v1', run: (input, context) => this.send(input, context.idempotencyKey),
  });
}
