import { defineUseCase, defineTransition, ok } from '../framework/index.js';
import { validateStart, start, validateConfirm, confirm, type StartInput, type ConfirmInput, type Loaded, type Change } from './domain.js';
import { RegistrationRepository } from './repository.js';
export async function digest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
export function registration(repository: RegistrationRepository) {
  const load = <I extends { id: string }>(input: I) => {
    const result = repository.read(input.id);
    return Promise.resolve(result.ok ? ok<Loaded<I>>({ current: result.value, input }) : result);
  };
  const save = (change: Change) => repository.save(change);
  const requested = defineUseCase({ operation: 'registration.request.v1', load: (input: StartInput) => load(input),
    transition: defineTransition({ validate: validateStart, evolve: start }), save });
  const confirmed = defineUseCase({ operation: 'registration.confirm.v1', load: (input: ConfirmInput) => load(input),
    transition: defineTransition({ validate: validateConfirm, evolve: confirm }), save });
  return {
    // Host generates secrets, not the person requesting registration.
    async request(input: { id: string; email: string }) {
      const token = crypto.randomUUID();
      return requested.run({ ...input, token, tokenDigest: await digest(token) });
    },
    async confirm(input: { id: string; token: string; now: number }) {
      return confirmed.run({ id: input.id, tokenDigest: await digest(input.token), now: input.now });
    },
  };
}
