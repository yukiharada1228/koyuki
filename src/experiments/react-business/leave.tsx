/** @jsx h */
import { workflow, ok, err, type Result } from '../../framework/index.js';
import { h, createContext, useContext, useOperation, Operation, operationKey } from './runtime.js';
import { ActorContext, useActor } from './expense.js';
import type { Actor } from '../../expenses/domain.js';
export type PendingLeave = Readonly<{ kind: 'pending'; id: string; owner: string; days: number }>;
export type ApprovedLeave = Readonly<{ kind: 'approved'; id: string; owner: string; days: number; by: string }>;
export type LeaveState = PendingLeave | ApprovedLeave;
export type LeaveInput = Readonly<{ id: string }>;
export type LeaveContext = Readonly<{ current: LeaveState; actor: Actor }>;
export type LeaveError = 'AlreadyDecided' | 'Forbidden' | 'SelfApproval';
function authorizeLeave({ current, actor }: LeaveContext): Result<{ current: PendingLeave; actor: Actor }, LeaveError> {
  if (current.kind !== 'pending') return err('AlreadyDecided');
  if (actor.id === current.owner) return err('SelfApproval');
  if (!actor.active || actor.role !== 'manager') return err('Forbidden');
  return ok({ current, actor });
}
function approveLeave({ current, actor }: { current: PendingLeave; actor: Actor }): Result<ApprovedLeave, never> {
  return ok({ ...current, kind: 'approved', by: actor.id });
}
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
