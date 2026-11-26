// Host scheduling policy, separate from both the pure domain and published core.
import { process, fromPromise, ok, err, type Result } from '../framework/index.js';
import { RegistrationRepository, type Delivery, type StorageError } from './repository.js';
import type { EmailRequested } from './domain.js';
import type { Tick } from './delivery.js';
export interface AbortableMailSender { send(event: EmailRequested, signal: AbortSignal): Promise<void> }
export interface HeartbeatPolicy {
  readonly everyMs: number;
  /** Same epoch and units as Tick.now; the host supplies its actual clock. */
  readonly now: () => number;
  /** Optional host scheduler. Must settle promptly when aborted. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
type LeaseError = StorageError | { kind: 'InvalidLease' } | { kind: 'HeartbeatUnavailable' };
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
async function deliver(repository: RegistrationRepository, sender: AbortableMailSender, policy: HeartbeatPolicy,
  { delivery, leaseMs }: { delivery: Delivery; leaseMs: number }): Promise<Result<Delivery, LeaseError | { kind: 'DeliveryUnavailable' }>> {
  // A delayed tick must not begin sending under an already expired claim.
  try {
    const ready = await repository.renew(delivery, policy.now(), leaseMs);
    if (!ready.ok) return ready;
  } catch { return err({ kind: 'HeartbeatUnavailable' }); }
  const timer = new AbortController(), sending = new AbortController();
  // Attach rejection handling immediately, including when ownership is lost first.
  const sent = fromPromise(() => sender.send(delivery.event, sending.signal), () => ({ kind: 'DeliveryUnavailable' as const }))();
  const heartbeat = (async (): Promise<Result<void, LeaseError>> => {
    try {
      while (!timer.signal.aborted) {
        try { await (policy.wait ?? wait)(policy.everyMs, timer.signal); }
        catch (cause) { if (timer.signal.aborted) return ok(undefined); throw cause; }
        if (timer.signal.aborted) break;
        const renewed = await repository.renew(delivery, policy.now(), leaseMs);
        if (!renewed.ok) return renewed;
      }
      return ok(undefined);
    } catch { return err({ kind: 'HeartbeatUnavailable' }); }
  })();
  const winner = await Promise.race([
    sent.then(result => ({ kind: 'sent' as const, result })),
    heartbeat.then(result => ({ kind: 'heartbeat' as const, result })),
  ]);
  timer.abort();
  const lease = await heartbeat;
  if (!lease.ok) { sending.abort(); return lease; }
  if (winner.kind !== 'sent') { sending.abort(); return err({ kind: 'HeartbeatUnavailable' }); }
  if (!winner.result.ok) return winner.result;
  // Sending may finish after expiry before the next scheduled heartbeat.
  // Recheck ownership before proceeding to acknowledgement.
  try {
    const renewed = await repository.renew(delivery, policy.now(), leaseMs);
    return renewed.ok ? ok(delivery) : renewed;
  } catch { return err({ kind: 'HeartbeatUnavailable' }); }
}
/** One attempt with explicit lease maintenance; no implicit resident worker or exactly-once promise. */
export function renewingEmailWorker(repository: RegistrationRepository, sender: AbortableMailSender, policy: HeartbeatPolicy) {
  if (!Number.isSafeInteger(policy.everyMs) || policy.everyMs <= 0 || policy.everyMs > 2_147_483_647) throw new RangeError('InvalidHeartbeatInterval');
  // Capture interval and callback identities while preserving method receivers.
  const configured = Object.freeze({ everyMs: policy.everyMs, now: policy.now.bind(policy), wait: policy.wait?.bind(policy) });
  return process<Tick>()
    .effect('claim-email', tick => configured.everyMs >= tick.leaseMs
      ? Promise.resolve(err({ kind: 'InvalidLease' as const })) : repository.claim(tick.now, tick.leaseMs), 'delivery')
    .effect('send-email', context => deliver(repository, sender, configured, context))
    .effect('ack-email', delivery => repository.acknowledge(delivery));
}
