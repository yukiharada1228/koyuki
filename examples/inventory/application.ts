import { defineTarget, step, withReplay } from 'koyuki';
import { validateReserve, requireStock, reserve, validateHeld, confirm, cancel, type Input, type Operation, type Change } from './domain.js';
import type { InventoryRepository } from './repository.js';

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
  const replay = (operation: Operation) => withReplay(commands[operation], {
    lookup: (input: Input) => repository.receipt(operation, input),
    resolveAfter: error => error.kind === 'Conflict' || error.kind === 'InvalidState' || error.kind === 'StorageUnavailable',
  });
  return { reserve: replay('reserve'), confirm: replay('confirm'), cancel: replay('cancel'), prepared: commands };
}
