/** @jsx h */
import { h, Fragment, createApplication } from 'koyuki/experimental';
import { ReplayExpenses, type ReplayExpenseRepository } from './expense-replay.js';
import { ReplayLeaves, type ReplayLeaveRepository } from './leave-replay.js';
import { Registrations, type RegistrationPort } from './registration.js';
import type { Actor } from './domain/expenses.js';

/** Trusted host supplies identity and atomic storage adapters, never event payloads. */
export function createBusinessApplication(ports: {
  expenses: ReplayExpenseRepository;
  leaves: ReplayLeaveRepository;
  registrations: RegistrationPort;
  actor: Actor;
}) {
  return createApplication(<Fragment>
    <ReplayExpenses repository={ports.expenses} actor={ports.actor} />
    <ReplayLeaves repository={ports.leaves} actor={ports.actor} />
    <Registrations repository={ports.registrations} actor={ports.actor} />
  </Fragment>);
}
export { replayedApproval } from './expense-replay.js';
export { replayedLeaveApproval } from './leave-replay.js';
export { registrationRequest, registrationConfirmation } from './registration.js';
