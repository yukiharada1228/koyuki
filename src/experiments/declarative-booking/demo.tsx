/** @jsx h */
import { ok } from '../../framework/index.js';
import { h, Fragment, createApplication, defineView, projection } from '../../framework/authoring.js';
import { AutomaticBookingBusiness, NotificationBusiness, ActorContext, requestAutomaticApproval } from './business.js';
import { memoryBookings } from './memory.js';
const repository = memoryBookings([{ kind: 'draft', id: 'one', owner: 'alice', startsAt: 2_000_000_000_000 }, { kind: 'draft', id: 'two', owner: 'alice', startsAt: 2_000_000_000_000 }]);
const app = createApplication(<ActorContext.Provider value={{ id: 'alice', role: 'member' }}><Fragment>
  <AutomaticBookingBusiness repository={repository} approver={{ id: 'boss', role: 'manager' }} />
  <NotificationBusiness sender={{ async send(mail) { console.log('mail', mail); return ok(null); } }} />
</Fragment></ActorContext.Provider>);
const report = await app.executeDetailed(requestAutomaticApproval, { id: 'one' });
console.log('request result', report.result);
console.log('deliveries', report.deliveries.map(row => ({ operation: row.operation, status: row.status })));
console.log('stored state', await repository.load({ id: 'one' }));
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
await session.dispatch({ type: 'request', input: { id: 'two' } });
unsubscribe();
