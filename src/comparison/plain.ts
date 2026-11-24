import { ok, type Result } from '../core.js';
import type { Execution, Operation } from './kernel.js';
import type { Backend, ReservationCandidate, OrderCandidate, ReservationSaved, OrderSaved, Conflict, MailRejected, AuditRejected } from './domain.js';

// Inline TS + Result baseline: exactly the same adapters, journal and failure semantics.
export async function reservationInline(execution: Execution, scope: string, backend: Backend, input: ReservationCandidate, audit?: Operation<ReservationSaved, void, AuditRejected>): Promise<Result<ReservationSaved, Conflict | MailRejected | AuditRejected>> {
  const saved = await execution.call(scope, 'reservation/commit', backend.saveReservation, input);
  if (!saved.ok) return saved;
  if (audit) {
    const audited = await execution.call(scope, 'reservation/before-notify', audit, saved.value);
    if (!audited.ok) return audited;
  }
  const notified = await execution.call(scope, 'reservation/notify', backend.notifyReservation, saved.value);
  if (!notified.ok) return notified;
  return ok(saved.value);
}
export async function orderInline(execution: Execution, scope: string, backend: Backend, input: OrderCandidate, audit?: Operation<OrderSaved, void, AuditRejected>): Promise<Result<OrderSaved, Conflict | MailRejected | AuditRejected>> {
  const saved = await execution.call(scope, 'order/commit', backend.saveOrder, input);
  if (!saved.ok) return saved;
  if (audit) {
    const audited = await execution.call(scope, 'order/before-notify', audit, saved.value);
    if (!audited.ok) return audited;
  }
  const notified = await execution.call(scope, 'order/notify', backend.notifyOrder, saved.value);
  if (!notified.ok) return notified;
  return ok(saved.value);
}
// Fairer baseline: plain TS can extract the same abstraction without JSX.
export async function commitAndNotify<C, S, CE, NE, AE = never>(execution: Execution, scope: string, name: string,
  commit: Operation<C, S, CE>, notify: Operation<NoInfer<S>, void, NE>, input: C, beforeNotify?: Operation<NoInfer<S>, void, AE>): Promise<Result<S, CE | NE | AE>> {
  const saved = await execution.call(scope, `${name}/commit`, commit, input);
  if (!saved.ok) return saved;
  if (beforeNotify) {
    const audited = await execution.call(scope, `${name}/before-notify`, beforeNotify, saved.value);
    if (!audited.ok) return audited;
  }
  const notified = await execution.call(scope, `${name}/notify`, notify, saved.value);
  if (!notified.ok) return notified;
  return ok(saved.value);
}
export const reservationShared = (execution: Execution, scope: string, backend: Backend, input: ReservationCandidate) =>
  commitAndNotify(execution, scope, 'reservation', backend.saveReservation, backend.notifyReservation, input);
export const orderShared = (execution: Execution, scope: string, backend: Backend, input: OrderCandidate) =>
  commitAndNotify(execution, scope, 'order', backend.saveOrder, backend.notifyOrder, input);
