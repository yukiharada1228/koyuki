import { defineTarget, step, type Result } from 'koyuki';
import { validateReserve, requireStock, reserve, validateHeld, confirm, cancel, type Input, type Operation, type Change, type Outcome, type DomainError } from './domain.js';
import type { InventoryRepository, StorageError } from './repository.js';

export const reserved = { validate: step('validate-reserve', validateReserve), require: [step('require-stock', requireStock)] as const, evolve: step('reserve', reserve) };
export const confirmed = { validate: step('validate-held', validateHeld), require: [] as const, evolve: step('confirm', confirm) };
export const cancelled = { validate: step('validate-held', validateHeld), require: [] as const, evolve: step('cancel', cancel) };
export function inventoryCommands(repository: InventoryRepository) {
  const target = (operation: Operation) => defineTarget({
    operation: `inventory.${operation}.v1`,
    load: (input: Input) => repository.load(operation, input),
    save: (change: Change) => repository.save(change),
  });
  const commands = { reserve: target('reserve').on(reserved), confirm: target('confirm').on(confirmed), cancel: target('cancel').on(cancelled) };
  // Application-owned orchestration: the current Koyuki API has no receipt/replay hook.
  // Replay must run before domain validation, because a successfully reserved order
  // is no longer in the input state required by the original command.
  function idempotent(operation: Operation) {
    return {
      async run(input: Input): Promise<Result<Outcome, DomainError | StorageError>> {
        // Snapshot before the first await; caller mutation must not change request identity.
        const request = Object.freeze({ ...input });
        const cached = repository.receipt(operation, request); if (!cached.ok) return cached;
        if (cached.value) return { ok: true, value: cached.value };
        const result = await commands[operation].run(request);
        if (result.ok) return result;
        // Another connection may have committed after the initial receipt lookup.
        const raced = repository.receipt(operation, request); if (!raced.ok) return raced;
        return raced.value ? { ok: true, value: raced.value } : result;
      },
    };
  }
  return { reserve: idempotent('reserve'), confirm: idempotent('confirm'), cancel: idempotent('cancel'), prepared: commands };
}
