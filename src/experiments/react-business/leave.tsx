/** @jsx h */
import { workflow, type Result } from '../../framework/index.js';
import { h, createContext, useContext, useOperation, Operation, operationKey } from './runtime.js';
import { ActorContext, useActor } from './expense.js';
import type { Actor } from '../../expenses/domain.js';
import { authorizeLeave, approveLeave, type LeaveInput, type LeaveContext, type ApprovedLeave } from './leave-domain.js';
export type { PendingLeave, ApprovedLeave, LeaveState, LeaveInput, LeaveContext, LeaveError, AuthorizedLeave, LeaveApprover } from './leave-domain.js';
export const leaveDecision = workflow('authorize-leave', authorizeLeave).then('approve-leave', approveLeave);
export interface LeaveRepository {
  load(input: LeaveInput, actor: Actor): Promise<Result<LeaveContext, 'NotFound'>>;
  save(value: ApprovedLeave): Promise<Result<ApprovedLeave, 'SaveConflict'>>;
}
export const LeaveRepositoryContext = createContext<LeaveRepository>();
const approvalId = 'leave.approve.v1';
export function useLeaveApproval() {
  const repository = useContext(LeaveRepositoryContext);
  const actor = useActor();
  return useOperation({ name: approvalId,
    load: (input: LeaveInput) => repository.load(input, actor),
    execute: leaveDecision,
    save: value => repository.save(value),
  });
}
export const leaveApproval = operationKey(approvalId, useLeaveApproval);
function ApproveLeave() {
  const handler = useLeaveApproval();
  return <Operation operation={leaveApproval} handler={handler} />;
}
export function Leaves({ repository, actor }: { repository: LeaveRepository; actor: Actor }) {
  return <LeaveRepositoryContext.Provider value={repository}>
    <ActorContext.Provider value={actor}><ApproveLeave /></ActorContext.Provider>
  </LeaveRepositoryContext.Provider>;
}
