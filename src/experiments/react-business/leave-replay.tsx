/** @jsx h */
import type { Result, Receipt, Execution } from '../../framework/index.js';
import { h, createContext, useContext, defineOperation, Operation } from './runtime.js';
import { ActorContext, useActor } from './expense.js';
import { leaveDecision } from './leave.js';
import type { Actor } from '../../expenses/domain.js';
import type { LeaveInput, LeaveContext, ApprovedLeave } from './leave-domain.js';
export type LeaveRequest = Readonly<{ requestId: string; input: LeaveInput }>;
export type LeaveIdentity = LeaveRequest & Readonly<{ actor: Actor }>;
export type LeaveStorageError = 'NotFound' | 'SaveConflict' | 'StorageUnavailable' | 'InvalidRequest' | 'IdempotencyConflict' | 'CorruptLeave';
export interface ReplayLeaveRepository {
  load(input: LeaveInput, actor: Actor): Promise<Result<LeaveContext, LeaveStorageError>>;
  receipt(request: LeaveIdentity): Result<Receipt<ApprovedLeave>, LeaveStorageError> | Promise<Result<Receipt<ApprovedLeave>, LeaveStorageError>>;
  saveRequest(request: LeaveIdentity, value: ApprovedLeave): Promise<Result<Execution<ApprovedLeave>, LeaveStorageError>>;
}
export const ReplayLeaveContext = createContext<ReplayLeaveRepository>();
export const replayedLeaveApproval = defineOperation('leave.approve.v1', () => {
  const repository = useContext(ReplayLeaveContext), actor = Object.freeze({ ...useActor() });
  const identity = (input: LeaveRequest): LeaveIdentity => ({ ...input, actor });
  return {
    load: (request: LeaveRequest) => repository.load(request.input, actor),
    execute: leaveDecision,
    save: (next, request) => repository.saveRequest(identity(request), next),
    replay: { lookup: request => repository.receipt(identity(request)), resolveAfter: error => error === 'SaveConflict' || error === 'StorageUnavailable' || error === 'AlreadyDecided' },
  };
});
export const useReplayLeaveApproval = replayedLeaveApproval.use;
export function ReplayLeaves({ repository, actor }: { repository: ReplayLeaveRepository; actor: Actor }) {
  return <ReplayLeaveContext.Provider value={repository}><ActorContext.Provider value={actor}><Operation operation={replayedLeaveApproval} /></ActorContext.Provider></ReplayLeaveContext.Provider>;
}
