import { process, workflow, type Result } from '../../framework/index.js';
import { validate, decide, type Input, type Validated, type Identification, type Decision, type Customer } from './domain.js';
export interface Ports {
  // The host owns scoped lookup, restoration and new-ID allocation.
  readonly identify: (input: Validated) => Promise<Result<Identification, { readonly kind: 'LookupUnavailable' }>>;
  // The host must enforce create uniqueness / update CAS atomically. Unchanged is a no-write result.
  readonly save: (input: Decision) => Promise<Result<Customer, { readonly kind: 'Conflict' }>>;
}
export function customerImport(ports: Ports) {
  return process<Input>()
    .through(workflow('validate-visitor', validate))
    .effect('identify-customer', ports.identify)
    .through(workflow('decide-customer', decide))
    .effect('save-customer', ports.save);
}
