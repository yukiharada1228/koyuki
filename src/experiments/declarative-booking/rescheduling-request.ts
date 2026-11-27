import { ok, err, type Result } from '../../framework/index.js';
import { parseRescheduleInput, type RescheduleInput, type ActorId } from './domain.js';
/** Execution metadata is separate from the pure rescheduling domain. */
export type RescheduleRequest = RescheduleInput & Readonly<{ requestId: string }>;
export type RescheduleRequestError = 'InvalidBookingInput' | 'InvalidBookingId' | 'InvalidRescheduleInput' | 'InvalidRequestId';
export interface ReschedulingIdentity { readonly key: string; readonly fingerprint: string; readonly actorId: ActorId }
export function parseRescheduleRequest(value: unknown): Result<RescheduleRequest, RescheduleRequestError> {
  const input = parseRescheduleInput(value);
  if (!input.ok) return input;
  if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string' || !value.requestId.trim()) return err('InvalidRequestId');
  return ok({ ...input.value, requestId: value.requestId });
}
