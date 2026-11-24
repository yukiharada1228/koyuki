/** @jsx h3 */
import { ok } from '../core.js';
import { Program, call, h3, type Operation } from './kernel.js';
import type { Backend, ReservationCandidate, OrderCandidate } from './domain.js';

// Specialize the component before JSX erases its result type.
// NoInfer keeps notify from widening the saved-state type inferred from commit.
export function defineCommitAndNotify<C, S, CE, NE, AE = never>(config: {
  name: string;
  commit: Operation<C, S, CE>;
  notify: Operation<NoInfer<S>, void, NE>;
  beforeNotify?: Operation<NoInfer<S>, void, AE>;
}) {
  return function CommitAndNotify({ input }: { input: C }): Program<S, CE | NE | AE> {
    return call(`${config.name}/commit`, config.commit, input).flatMap(saved => {
      const notify = () => call(`${config.name}/notify`, config.notify, saved).flatMap(() =>
        new Program('saved-result', async () => ok(saved)));
      return config.beforeNotify
        ? call(`${config.name}/before-notify`, config.beforeNotify, saved).flatMap(notify)
        : notify();
    });
  };
}
export function createProcesses(backend: Backend) {
  const ReservationCommit = defineCommitAndNotify({ name: 'reservation', commit: backend.saveReservation, notify: backend.notifyReservation });
  const OrderCommit = defineCommitAndNotify({ name: 'order', commit: backend.saveOrder, notify: backend.notifyOrder });
  function ReservationProcess({ input }: { input: ReservationCandidate }) {
    return <ReservationCommit input={input} />;
  }
  function OrderProcess({ input }: { input: OrderCandidate }) {
    return <OrderCommit input={input} />;
  }
  return { ReservationProcess, OrderProcess, ReservationCommit, OrderCommit };
}
