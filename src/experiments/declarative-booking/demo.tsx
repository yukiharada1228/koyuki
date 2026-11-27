/** @jsx h */
import { bookingId, actorId } from './domain.js';
import { ok } from '../../framework/index.js';
import { h, Fragment, createApplication, defineView, projection } from '../../framework/authoring.js';
import { AutomaticBookingBusiness, NotificationBusiness, ActorContext, requestAutomaticApproval } from './business.js';
import { memoryBookings } from './memory.js';
import { ReschedulingBusiness, ReschedulingNotifications, rescheduleBooking } from './rescheduling.js';
import { parseRescheduleRequest } from './rescheduling-request.js';
import { collect } from '../../framework/index.js';
async function main() {
  const seed = collect({ one: bookingId('one'), two: bookingId('two'), alice: actorId('alice'), boss: actorId('boss') });
  if (!seed.ok) return seed;
  const repository = memoryBookings([{ kind: 'draft', id: seed.value.one, owner: seed.value.alice, startsAt: 2_000_000_000_000 }, { kind: 'draft', id: seed.value.two, owner: seed.value.alice, startsAt: 2_000_000_000_000 }]);
  const app = createApplication(<ActorContext.Provider value={{ id: seed.value.alice, role: 'member' }}><Fragment>
    <AutomaticBookingBusiness repository={repository} approver={{ id: seed.value.boss, role: 'manager' }} />
    <NotificationBusiness sender={{ async send(mail) { console.log('mail', mail); return ok(null); } }} />
    <ReschedulingBusiness repository={repository} clock={() => 2_000_000_000_000 - 48 * 3_600_000} noticeHours={24} />
    <ReschedulingNotifications sender={{ async send(notice) { console.log('rescheduled', notice); return ok(null); } }} />
  </Fragment></ActorContext.Provider>);
  const report = await app.executeDetailed(requestAutomaticApproval, { id: seed.value.one });
  console.log('request result', report.result);
  console.log('deliveries', report.deliveries.map(row => ({ operation: row.operation, status: row.status })));
  console.log('stored state', await repository.load({ id: seed.value.one }));
  const input = parseRescheduleRequest({ requestId: 'reschedule-one-1', id: 'one', startsAt: 2_000_000_000_000 + 72 * 3_600_000 });
  if (!input.ok) return input;
  const rescheduled = await app.executeDetailed(rescheduleBooking, input.value);
  console.log('rescheduling result', rescheduled.result);
  console.log('rescheduling replay', await app.execute(rescheduleBooking, input.value));
  // Recovery workers acknowledge each event only after all its own consumers succeed.
  // This in-process demo has no crash durability and never sends real email.

  // A separate presentation session over the same JSX-mounted operations.
  const view = defineView({
    initial: (): { accepted: readonly string[] } => ({ accepted: [] }),
    operations: {
      request: projection(requestAutomaticApproval, (state: { accepted: readonly string[] }, result) => ({ accepted: [...new Set([...state.accepted, result.value.id])] })),
    },
    view: state => ({ accepted: state.data.accepted, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error : null }),
  });
  const session = await app.start(view);
  const unsubscribe = session.subscribe(snapshot => console.log('presentation', snapshot.view));
  await session.dispatch({ type: 'request', input: { id: seed.value.two } });
  unsubscribe();
  return ok(null);
}
console.log(await main());
