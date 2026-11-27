/** @jsx h */
import { workflow, ok, err, type Result, type Receipt, type Execution } from '../../framework/index.js';
import { h, createContext, useContext, defineOperation, Operation, Fragment, defineResource, defineEvent, emit, defineQuery, Query, type EventEnvelope } from './runtime.js';
import { useActor, ActorContext } from './expense.js';
import { digestToken as digest } from '../../registration/secrets.js';
import type { Actor } from '../../expenses/domain.js';
import { validateStart, start, validateConfirm, confirm, type Loaded, type StartInput, type ConfirmInput, type Registration, type Change } from '../../registration/domain.js';
export const requestRegistration = workflow('validate-registration', validateStart).then('request-registration', start);
export const confirmRegistration = workflow('validate-confirmation', validateConfirm).then('confirm-registration', confirm);
export type RegistrationRequest = Readonly<{ requestId: string; id: string; email: string }>;
export type ConfirmationRequest = Readonly<{ requestId: string; id: string; token: string; now: number }>;
export type RegistrationCall = Readonly<{ operation: 'request'; input: RegistrationRequest; actor: Actor } | { operation: 'confirm'; input: ConfirmationRequest; actor: Actor }>;
export type RegistrationStorageError = { kind: 'StorageUnavailable' } | { kind: 'Conflict' } | { kind: 'CorruptRegistration' } | { kind: 'InvalidRequest' } | { kind: 'IdempotencyConflict' };
export interface RegistrationPort {
  read(id: string): Result<Registration | null, RegistrationStorageError> | Promise<Result<Registration | null, RegistrationStorageError>>;
  receipt(call: RegistrationCall): Result<Receipt<Registration>, RegistrationStorageError> | Promise<Result<Receipt<Registration>, RegistrationStorageError>>;
  saveRequest(call: RegistrationCall, change: Change, events?: readonly EventEnvelope[]): Promise<Result<Execution<Registration>, RegistrationStorageError>>;
}
export const RegistrationContext = createContext<RegistrationPort>();
function useRegistrationServices() {
  return { repository: useContext(RegistrationContext), actor: useActor() };
}
export const registrationChanged = defineEvent<{ id: string }>('registration.changed.v1', {
  external: true,
  decode: value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id ? ok({ id: value.id }) : err('InvalidRegistrationEvent'),
});
const registrationInput = defineResource('prepare-registration-secret', () => async (input: RegistrationRequest) => {
  const token = crypto.randomUUID();
  return ok<StartInput>({ id: input.id, email: input.email, token, tokenDigest: await digest(token) });
});
const registrationCurrent = defineResource('current-registration', {
  needs: { input: registrationInput },
  useLoad: () => { const repository = useContext(RegistrationContext); return ({ input }: { input: StartInput }) => repository.read(input.id); },
});
const confirmationInput = defineResource('digest-confirmation-token', () => async (input: ConfirmationRequest) => ok<ConfirmInput>({ id: input.id, now: input.now, tokenDigest: await digest(input.token) }));
const confirmationCurrent = defineResource('confirmation-registration', {
  needs: { input: confirmationInput },
  useLoad: () => { const repository = useContext(RegistrationContext); return ({ input }: { input: ConfirmInput }) => repository.read(input.id); },
});
export const registrationRequest = defineOperation('registration.request.v1', {
  needs: { current: registrationCurrent, input: registrationInput }, execute: requestRegistration,
  emits: [emit(registrationChanged, (change: Change) => ({ id: change.next.id }))],
  useSave: () => { const { repository, actor } = useRegistrationServices();
    return (change: Change, input: RegistrationRequest, events: readonly EventEnvelope[]) => repository.saveRequest({ operation: 'request', input, actor }, change, events);
  },
  useReplay: () => { const { repository, actor } = useRegistrationServices(); return {
    lookup: (input: RegistrationRequest) => repository.receipt({ operation: 'request', input, actor }),
    resolveAfter: (error: { kind: string }) => error.kind === 'Conflict' || error.kind === 'StorageUnavailable' || error.kind === 'AlreadyRegistered',
  }; },
});
export const registrationConfirmation = defineOperation('registration.confirm.v1', {
  needs: { current: confirmationCurrent, input: confirmationInput }, execute: confirmRegistration,
  emits: [emit(registrationChanged, (change: Change) => ({ id: change.next.id }))],
  useSave: () => { const { repository, actor } = useRegistrationServices();
    return (change: Change, input: ConfirmationRequest, events: readonly EventEnvelope[]) => repository.saveRequest({ operation: 'confirm', input, actor }, change, events);
  },
  useReplay: () => { const { repository, actor } = useRegistrationServices(); return {
    lookup: (input: ConfirmationRequest) => repository.receipt({ operation: 'confirm', input, actor }),
    resolveAfter: (error: { kind: string }) => error.kind === 'Conflict' || error.kind === 'StorageUnavailable' || error.kind === 'InvalidConfirmation',
  }; },
});
export type RegistrationView = Readonly<{ id: string; email: string } & ({ kind: 'awaiting'; version: 1 } | { kind: 'confirmed'; version: 2; confirmedAt: number })>;
export function registrationView(value: Registration | null): RegistrationView | null {
  return value === null ? null : value.kind === 'awaiting' ? { id: value.id, email: value.email, kind: value.kind, version: value.version } : { id: value.id, email: value.email, kind: value.kind, version: value.version, confirmedAt: value.confirmedAt };
}
const registrationRead = defineResource('registration-query', () => {
  const { repository, actor } = useRegistrationServices();
  return async (input: RegistrationRequest): Promise<Result<Registration | null, RegistrationStorageError | { kind: 'Forbidden' }>> => {
    if (!actor.active) return err({ kind: 'Forbidden' });
    // A registration belongs to the authenticated identity that created its receipt.
    const receipt = await repository.receipt({ operation: 'request', input, actor });
    return !receipt.ok ? receipt : receipt.value.kind === 'missing' ? ok(null) : repository.read(input.id);
  };
});
export const registrationQuery = defineQuery('registration.query.v1', { needs: registrationRead, select: (value: Registration | null) => ok(registrationView(value)) });
export function Registrations({ repository, actor }: { repository: RegistrationPort; actor: Actor }) {
  return <RegistrationContext.Provider value={repository}><ActorContext.Provider value={actor}><Fragment><Operation operation={registrationRequest} /><Operation operation={registrationConfirmation} /><Query query={registrationQuery} /></Fragment></ActorContext.Provider></RegistrationContext.Provider>;
}
