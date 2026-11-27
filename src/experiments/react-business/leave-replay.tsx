/** @jsx h */
import type { Result, Receipt, Execution } from '../../framework/index.js';
import { h, createContext, useContext, useOperation, Operation, operationKey } from './runtime.js';
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
const approvalName = 'leave.approve.v1';
export function useReplayLeaveApproval() {
  const repository = useContext(ReplayLeaveContext), actor = Object.freeze({ ...useActor() });
  const identity = (input: LeaveRequest): LeaveIdentity => ({ ...input, actor });
  return useOperation({ name: approvalName,
    load: (request: LeaveRequest) => repository.load(request.input, actor),
    execute: leaveDecision,
    save: (next, request) => repository.saveRequest(identity(request), next),
    replay: { lookup: request => repository.receipt(identity(request)), resolveAfter: error => error === 'SaveConflict' || error === 'StorageUnavailable' || error === 'AlreadyDecided' },
  });
}
export const replayedLeaveApproval = operationKey(approvalName, useReplayLeaveApproval);
function ApproveLeave() {
  const handler = useReplayLeaveApproval();
  return <Operation operation={replayedLeaveApproval} handler={handler} />;
}
export function ReplayLeaves({ repository, actor }: { repository: ReplayLeaveRepository; actor: Actor }) {
  return <ReplayLeaveContext.Provider value={repository}><ActorContext.Provider value={actor}><ApproveLeave /></ActorContext.Provider></ReplayLeaveContext.Provider>;
}
