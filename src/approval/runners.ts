import { OrderProcess, type Plan } from './declarative.js';
import { Host, type Outcome, type RecordState, type Failure } from './host.js';
import type { State } from './domain.js';
function terminal(state: State): Outcome | null {
  if (state.kind === 'complete') return { status: 'complete' };
  if (state.kind === 'rejected') return { status: 'rejected', reason: state.reason };
  return null;
}
async function interpret(host: Host, id: string, record: RecordState, plan: Plan): Promise<Outcome | null> {
  switch (plan.kind) {
    case 'advance': host.apply(id, record.revision, { type: 'advance' }); return null;
    case 'wait': return { status: 'waiting', stage: plan.stage, requestId: plan.requestId };
    case 'done': return terminal(record.state);
    case 'commit': {
      // The interpreter does not trust a detached plan built from an old state.
      if (record.state.kind !== 'ready' || JSON.stringify(plan.input) !== JSON.stringify(record.state.order)) throw new Error('StalePlan');
      const failures = await host.commit(id, record); return failures.length ? { status: 'failed', failures } : null;
    }
    case 'parallel': {
      if (record.state.kind !== 'committed') throw new Error('InvalidParallelState');
      for (const child of plan.children) if (JSON.stringify(child.input) !== JSON.stringify(record.state.order)) throw new Error('StalePlan');
      const failures = await host.fulfill(id, record, plan.children.map(child => child.operation));
      return failures.length ? { status: 'failed', failures } : null;
    }
    case 'effect': throw new Error('EffectRequiresFulfillmentBoundary');
  }
}
export async function runDeclarative(host: Host, id: string): Promise<Outcome> {
  for (let step = 0; step < 16; step++) {
    const record = host.read(id);
    const result = await interpret(host, id, record, OrderProcess({ state: record.state }));
    if (result) return result;
  }
  throw new Error('TransitionLimit');
}
// Fair baseline: same typed domain functions, storage and operation journal.
// It is allowed to extract helpers; the difference is the declarative tree/interpreter.
export async function runPlain(host: Host, id: string): Promise<Outcome> {
  for (let step = 0; step < 16; step++) {
    const record = host.read(id), state = record.state;
    switch (state.kind) {
      case 'draft': host.apply(id, record.revision, { type: 'advance' }); break;
      case 'waiting': return { status: 'waiting', stage: state.stage, requestId: state.requestId };
      case 'ready': {
        const failures = await host.commit(id, record);
        if (failures.length) return { status: 'failed', failures };
        break;
      }
      case 'committed': {
        const failures = await host.fulfill(id, record, ['notify', 'ship']);
        if (failures.length) return { status: 'failed', failures };
        break;
      }
      case 'complete': return { status: 'complete' };
      case 'rejected': return { status: 'rejected', reason: state.reason };
    }
  }
  throw new Error('TransitionLimit');
}
