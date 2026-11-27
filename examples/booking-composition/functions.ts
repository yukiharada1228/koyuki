import { defineCommand } from 'koyuki';
import { definitions, type BookingProps } from './definitions.js';
import type { Actor } from './domain.js';
/** Same definitions and engine; composition uses explicit arguments, not JSX. */
export function createBookingService(props: BookingProps, authenticatedActor: Actor) {
  const spec = definitions(props, authenticatedActor);
  const submit = defineCommand({ operation: 'booking.submit.v1', load: spec.submit.load, decide: spec.submit.execute, save: spec.submit.save });
  const approve = defineCommand({ operation: 'booking.approve.v1', load: spec.approve.load, decide: spec.approve.execute, save: spec.approve.save });
  const cancel = defineCommand({ operation: 'booking.cancel.v1', load: spec.cancel.load, decide: spec.cancel.execute, save: spec.cancel.save });
  return { submit: submit.run, approve: approve.run, cancel: cancel.run,
    detailed: { submit: submit.runDetailed, approve: approve.runDetailed, cancel: cancel.runDetailed } };
}
