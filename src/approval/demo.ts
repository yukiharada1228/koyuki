import { Backend } from './backend.js';
import { Host } from './host.js';
import { Execution } from '../comparison/kernel.js';
import { extraApproval } from './domain.js';
import { OrderProcess } from './declarative.js';
import { runDeclarative, runPlain } from './runners.js';
for (const mode of ['declarative', 'plain'] as const) {
  const backend = new Backend(), host = new Host(backend, new Execution());
  const run = () => (mode === 'declarative' ? runDeclarative : runPlain)(host, 'demo');
  host.start({ id: 'demo', amount: 150_000 }, extraApproval);
  const show = async (label: string) => {
    const outcome = await run();
    console.log(JSON.stringify({ mode, label, outcome, state: host.read('demo').state, currentPlan: OrderProcess({ state: host.read('demo').state }), calls: backend.calls, deliveries: backend.deliveries, shipments: backend.shipments }, null, 2));
  };
  const approve = (eventId: string) => {
    const state = host.read('demo').state;
    if (state.kind !== 'waiting') throw new Error('ExpectedApproval');
    host.receive({ type: 'approval', eventId, orderId: 'demo', requestId: state.requestId, stage: state.stage, actorRole: state.stage, decision: 'approve' });
  };
  await show('manager approval pending');
  approve('manager-yes'); await show('finance approval pending');
  backend.notifyFailure = 'infrastructure'; approve('finance-yes'); await show('mail failed; shipping succeeded');
  backend.notifyFailure = 'none'; await show('retry only mail; complete');
}
