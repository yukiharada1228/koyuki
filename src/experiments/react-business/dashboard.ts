import { defineView, projection, refreshQuery } from '../../framework/authoring.js';
import type { ExpenseState } from '../../expenses/domain.js';
import type { LeaveState } from './leave-domain.js';
import { replayedApproval, expenseChanged, expenseQuery } from './expense-replay.js';
import { replayedLeaveApproval, leaveChanged, leaveQuery } from './leave-replay.js';
import { registrationRequest, registrationConfirmation, registrationChanged, registrationQuery, type RegistrationRequest, type RegistrationView } from './registration.js';
export interface DashboardData {
  readonly expenseId: string;
  readonly leaveId: string;
  readonly registrationRequest: RegistrationRequest;
  readonly expense: ExpenseState | null;
  readonly leave: LeaveState | null;
  readonly registration: RegistrationView | null;
}
/** Only intent: operations, read models and their invalidating domain events. */
export function businessDashboard(target: Pick<DashboardData, 'expenseId' | 'leaveId' | 'registrationRequest'>) {
  return defineView({
    initial: (): DashboardData => ({ ...target, expense: null, leave: null, registration: null }),
    operations: {
      approveExpense: projection(replayedApproval),
      approveLeave: projection(replayedLeaveApproval),
      register: projection(registrationRequest),
      confirmRegistration: projection(registrationConfirmation),
    },
    queries: {
      expense: refreshQuery(expenseQuery, { input: (state: DashboardData) => ({ id: state.expenseId }), on: [expenseChanged], reduce: (state: DashboardData, expense) => ({ ...state, expense }) }),
      leave: refreshQuery(leaveQuery, { input: (state: DashboardData) => ({ id: state.leaveId }), on: [leaveChanged], reduce: (state: DashboardData, leave) => ({ ...state, leave }) }),
      registration: refreshQuery(registrationQuery, { input: (state: DashboardData) => state.registrationRequest, on: [registrationChanged], reduce: (state: DashboardData, registration) => ({ ...state, registration }) }),
    },
    view: state => ({
      expense: state.data.expense,
      leave: state.data.leave,
      registration: state.data.registration,
      busy: state.kind === 'running' || state.refreshing,
      error: state.kind === 'failed' ? state.error : state.kind === 'crashed' ? state.error : null,
      queries: state.queries,
    }),
  });
}
