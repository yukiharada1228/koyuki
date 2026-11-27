/** @jsx h */
import { workflow, process, ok, type Result, type Receipt, type Execution } from '../../framework/index.js';
import { h, createContext, useContext, useOperation, Operation, operationKey, Fragment } from './runtime.js';
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
  saveRequest(call: RegistrationCall, change: Change): Promise<Result<Execution<Registration>, RegistrationStorageError>>;
}
export const RegistrationContext = createContext<RegistrationPort>();
async function loadRegistration<I extends { id: string }>(repository: RegistrationPort, input: I) {
  const current = await repository.read(input.id);
  return current.ok ? ok<Loaded<I>>({ current: current.value, input }) : current;
}
function useRegistrationServices() {
  return { repository: useContext(RegistrationContext), actor: Object.freeze({ ...useActor() }) };
}
const requestName = 'registration.request.v1', confirmName = 'registration.confirm.v1';
export function useRegistrationRequest() {
  const { repository, actor } = useRegistrationServices();
  const call = (input: RegistrationRequest): RegistrationCall => ({ operation: 'request', input, actor });
  const load = process<RegistrationRequest>()
    .effect('prepare-registration-secret', async input => {
      const token = crypto.randomUUID();
      return ok<StartInput>({ id: input.id, email: input.email, token, tokenDigest: await digest(token) });
    })
    .effect('load-registration', input => loadRegistration(repository, input));
  return useOperation({ name: requestName, load, execute: requestRegistration,
    save: (change, input) => repository.saveRequest(call(input), change),
    replay: { lookup: input => repository.receipt(call(input)), resolveAfter: error => error.kind === 'Conflict' || error.kind === 'StorageUnavailable' || error.kind === 'AlreadyRegistered' },
  });
}
export function useRegistrationConfirmation() {
  const { repository, actor } = useRegistrationServices();
  const call = (input: ConfirmationRequest): RegistrationCall => ({ operation: 'confirm', input, actor });
  const load = process<ConfirmationRequest>()
    .effect('digest-confirmation-token', async input => ok<ConfirmInput>({ id: input.id, now: input.now, tokenDigest: await digest(input.token) }))
    .effect('load-registration', input => loadRegistration(repository, input));
  return useOperation({ name: confirmName, load, execute: confirmRegistration,
    save: (change, input) => repository.saveRequest(call(input), change),
    replay: { lookup: input => repository.receipt(call(input)), resolveAfter: error => error.kind === 'Conflict' || error.kind === 'StorageUnavailable' || error.kind === 'InvalidConfirmation' },
  });
}
export const registrationRequest = operationKey(requestName, useRegistrationRequest);
export const registrationConfirmation = operationKey(confirmName, useRegistrationConfirmation);
function RegistrationOperations() {
  const requested = useRegistrationRequest(), confirmed = useRegistrationConfirmation();
  return <Fragment>
    <Operation operation={registrationRequest} handler={requested} />
    <Operation operation={registrationConfirmation} handler={confirmed} />
  </Fragment>;
}
export function Registrations({ repository, actor }: { repository: RegistrationPort; actor: Actor }) {
  return <RegistrationContext.Provider value={repository}><ActorContext.Provider value={actor}><RegistrationOperations /></ActorContext.Provider></RegistrationContext.Provider>;
}
