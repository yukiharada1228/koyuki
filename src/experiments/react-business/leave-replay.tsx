/** @jsx h */
import { ok, err, type Result, type Receipt, type Execution } from '../../framework/index.js';
import { h, createContext, useContext, defineOperation, Operation, defineResource, defineEvent, emit, defineQuery, Query, Fragment, type EventEnvelope } from './runtime.js';
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
  saveRequest(request: LeaveIdentity, value: ApprovedLeave, events?: readonly EventEnvelope[]): Promise<Result<Execution<ApprovedLeave>, LeaveStorageError>>;
}
export const ReplayLeaveContext = createContext<ReplayLeaveRepository>();
export const leaveChanged = defineEvent<{ id: string }>('leave.changed.v1', { external: true, decode: value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id ? ok({ id: value.id }) : err('InvalidLeaveEvent') });
const leaveContext = defineResource('leave-approval-context', () => {
  const repository = useContext(ReplayLeaveContext), actor = useActor();
  return (request: LeaveRequest) => repository.load(request.input, actor);
});
function useLeaveServices() { return { repository: useContext(ReplayLeaveContext), actor: useActor() }; }
export const replayedLeaveApproval = defineOperation('leave.approve.v1', {
  needs: leaveContext, execute: leaveDecision, emits: [emit(leaveChanged, (value: ApprovedLeave) => ({ id: value.id }))],
  useSave: () => { const { repository, actor } = useLeaveServices();
    return (next: ApprovedLeave, request: LeaveRequest, events: readonly EventEnvelope[]) => repository.saveRequest({ ...request, actor }, next, events);
  },
  useReplay: () => { const { repository, actor } = useLeaveServices(); return {
    lookup: (request: LeaveRequest) => repository.receipt({ ...request, actor }),
    resolveAfter: (error: string) => error === 'SaveConflict' || error === 'StorageUnavailable' || error === 'AlreadyDecided',
  }; },
});
const leaveRead = defineResource('leave-query', () => {
  const { repository, actor } = useLeaveServices();
  return async (input: LeaveInput) => {
    if (!actor.active) return err('Forbidden' as const);
    const result = await repository.load(input, actor);
    return result.ok ? actor.role === 'employee' && result.value.current.owner !== actor.id ? err('Forbidden' as const) : ok(result.value.current) : result;
  };
});
export const leaveQuery = defineQuery('leave.query.v1', { needs: leaveRead, select: (state: import('./leave-domain.js').LeaveState) => ok(state) });
export function ReplayLeaves({ repository, actor }: { repository: ReplayLeaveRepository; actor: Actor }) {
  return <ReplayLeaveContext.Provider value={repository}><ActorContext.Provider value={actor}><Fragment><Operation operation={replayedLeaveApproval} /><Query query={leaveQuery} /></Fragment></ActorContext.Provider></ReplayLeaveContext.Provider>;
}
