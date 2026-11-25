import { process, defineTarget, defineTransition, fromPromise, ok } from '../framework/index.js';
import { RegistrationRepository, type Delivery } from './repository.js';
import type { EmailRequested } from './domain.js';
export interface Tick { readonly now: number; readonly leaseMs: number }
export interface MailSender { send(event: EmailRequested): Promise<void> }
/** One delivery attempt. Host schedules retries after lease expiry, never the pure domain. */
export function emailWorker(repository: RegistrationRepository, sender: MailSender) {
  const send = fromPromise(async (delivery: Delivery) => {
    await sender.send(delivery.event); // stable event.id is the transport idempotency key
    return delivery;
  }, () => ({ kind: 'DeliveryUnavailable' as const }));
  const acknowledgement = defineTarget({ operation: 'registration.email.ack.v1',
    load: async (delivery: Delivery) => ok(delivery), save: (delivery: Delivery) => repository.acknowledge(delivery),
  }).on(defineTransition({ validate: (delivery: Delivery) => ok(delivery), evolve: (delivery: Delivery) => ok(delivery) }));
  return process<Tick>()
    .effect('claim-email', tick => repository.claim(tick.now, tick.leaseMs))
    .effect('send-email', send)
    .commit(acknowledgement);
}
