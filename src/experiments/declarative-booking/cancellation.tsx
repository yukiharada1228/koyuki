/** @jsx h */
import { ok, err, type Result, type Execution, type Receipt } from '../../framework/index.js';
import { h, createContext, useContext, defineResource, defineEvent, emit, defineOperation, Operation, On, type EventEnvelope } from '../../framework/authoring.js';
import { ActorContext, authenticatedActor, type BookingRepository } from './business.js';
import { parseBookingInput, type ActorId, type Context, type Input, type BookingId } from './domain.js';
import { feeCancellation, validFeePolicy, restoreCancellationSettlement, type CancellationFacts, type CancellationSettlement, type FeePolicy, type FeeCancellationError, type PaymentId, type CancellationRecord } from './cancellation-domain.js';
export type CancellationRequest = Input & Readonly<{ requestId: string }>;
export type CancellationInputError = 'InvalidBookingInput' | 'InvalidBookingId' | 'InvalidRequestId';
export { restoreCancellationRecord, type CancellationRecord } from './cancellation-domain.js';
export type CancellationStorageError = 'StorageFailed' | 'ConcurrentChange' | 'IdempotencyConflict';
export type CancellationIdentity = Readonly<{ actorId: ActorId; key: string; fingerprint: string }>;
export function parseCancellationRequest(value: unknown): Result<CancellationRequest, CancellationInputError> {
  const input = parseBookingInput(value);
  if (!input.ok) return input;
  if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string' || !value.requestId.trim()) return err('InvalidRequestId');
  return ok({ id: input.value.id, requestId: value.requestId });
}
export interface FeeCancellationRepository extends Pick<BookingRepository, 'load'> {
  cancellationFacts(input: Input, actorId: ActorId): Promise<Result<CancellationFacts, 'MissingPayment' | 'StorageFailed'>>;
  cancellationReceipt(input: CancellationRequest, identity: CancellationIdentity): Promise<Result<Receipt<CancellationRecord>, 'StorageFailed' | 'IdempotencyConflict'>>;
  cancelWithFee(record: CancellationRecord, input: CancellationRequest, events: readonly EventEnvelope[], identity: CancellationIdentity): Promise<Result<Execution<CancellationRecord>, CancellationStorageError>>;
}
const Repository = createContext<FeeCancellationRepository>();
const Policy = createContext<FeePolicy & Readonly<{ clock: () => number }>>();
const current = defineResource('current-booking', () => { const repository = useContext(Repository); return (input: CancellationRequest) => repository.load(input); });
const facts = defineResource('cancellation-facts', { needs: { booking: current, actor: authenticatedActor }, useLoad: () => {
  const repository = useContext(Repository);
  return ({ booking, actor }: Context): Promise<Result<CancellationFacts, 'InvalidState' | 'Forbidden' | 'MissingPayment' | 'StorageFailed'>> => {
    if (booking.kind !== 'confirmed') return Promise.resolve(err('InvalidState'));
    if (booking.owner !== actor.id) return Promise.resolve(err('Forbidden'));
    return repository.cancellationFacts({ id: booking.id }, actor.id);
  };
} });
const time = defineResource('cancellation-time', () => { const { clock, ...policy } = useContext(Policy); return () => ok({ ...policy, now: clock() }); });
export const bookingCancelledWithFee = defineEvent<CancellationSettlement>('booking.cancelled-with-fee.v1', { decode: restoreCancellationSettlement });
function useCancellationIdentity() {
  const actorId = useContext(ActorContext).id;
  return (input: CancellationRequest): Result<CancellationIdentity, CancellationInputError> => {
    const parsed = parseCancellationRequest(input);
    return parsed.ok ? ok({ actorId, key: parsed.value.requestId, fingerprint: JSON.stringify([cancelBookingWithFee.name, parsed.value.id, actorId]) }) : parsed;
  };
}
export const cancelBookingWithFee = defineOperation('booking.cancel-with-fee.v1', {
  needs: { booking: current, actor: authenticatedActor, facts, time }, execute: feeCancellation,
  emits: [emit(bookingCancelledWithFee)],
  useSave: () => {
    const repository = useContext(Repository), identify = useCancellationIdentity();
    return async (settlement: CancellationSettlement, input: CancellationRequest, events: readonly EventEnvelope[]) => {
      const identity = identify(input);
      return identity.ok ? repository.cancelWithFee({ requestId: input.requestId, settlement }, input, events, identity.value) : identity;
    };
  },
  useReplay: () => {
    const repository = useContext(Repository), identify = useCancellationIdentity();
    return {
      lookup: async (input: CancellationRequest): Promise<Result<Receipt<CancellationRecord>, 'StorageFailed' | 'IdempotencyConflict' | CancellationInputError>> => {
        const identity = identify(input); return identity.ok ? repository.cancellationReceipt(input, identity.value) : identity;
      },
      resolveAfter: (error: FeeCancellationError | CancellationStorageError | CancellationInputError | 'Missing' | 'MissingPayment') => error !== 'IdempotencyConflict',
    };
  },
});
export function FeeCancellationBusiness({ repository, clock, lateWithinHours = 24, lateFeeBps = 5000 }: { repository: FeeCancellationRepository; clock: () => number } & Partial<FeePolicy>) {
  if (!validFeePolicy({ lateWithinHours, lateFeeBps })) throw new Error('InvalidFeePolicy');
  return <Repository.Provider value={repository}><Policy.Provider value={Object.freeze({ clock, lateWithinHours, lateFeeBps })}><Operation operation={cancelBookingWithFee} /></Policy.Provider></Repository.Provider>;
}
export type RefundRequest = Readonly<{ idempotencyKey: string; bookingId: BookingId; paymentId: PaymentId; amountMinor: number }>;
export interface RefundGateway { refund(request: RefundRequest): Promise<Result<null, 'RefundUnavailable' | 'RefundConflict'>> }
const Gateway = createContext<RefundGateway>();
const cancelled = defineResource('cancellation-event', () => (settlement: CancellationSettlement) => restoreCancellationSettlement(settlement));
export const refundCancellation = defineOperation('booking.refund-cancellation.v1', {
  needs: cancelled,
  execute: (settlement: CancellationSettlement) => ok({ idempotencyKey: JSON.stringify([bookingCancelledWithFee.name, settlement.next.id, settlement.facts.paymentId]), bookingId: settlement.next.id, paymentId: settlement.facts.paymentId, amountMinor: settlement.refundMinor }),
  useSave: () => {
    const gateway = useContext(Gateway);
    return (request: RefundRequest) => request.amountMinor === 0 ? Promise.resolve(ok(null)) : gateway.refund(request);
  },
});
export function CancellationRefunds({ gateway }: { gateway: RefundGateway }) {
  return <Gateway.Provider value={gateway}><On event={bookingCancelledWithFee} operation={refundCancellation} /></Gateway.Provider>;
}
